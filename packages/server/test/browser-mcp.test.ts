import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MetricsCollector } from "../src/agent/metrics.ts";
import { buildPrompt } from "../src/agent/prompt.ts";
import { browserSettingsFromEnv } from "../src/salesforce/browser.ts";
import { BROWSER_MCP_SCRIPT } from "../src/paths.ts";
import { mcpServers } from "../src/runs/runner.ts";

const dir = mkdtempSync(join(tmpdir(), "sfqa-browser-mcp-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const text = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content).map((c) => c.text ?? "").join("\n");

test("the hybrid browser serves the Playwright tools and run_steps on one shared page", { timeout: 120_000 }, async () => {
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
  const servers = mcpServers({
    personas: [{ persona: { id: "p", name: "P" } as never, user: { id: "u", name: "U", username: "u@x" }, stateFile: state, server: "playwright" }],
    runDir: dir, browser: { ...browserSettingsFromEnv(), headless: true }, playwrightMcpCli: "unused", qaMcpScript: "qa.ts",
    serverUrl: "http://127.0.0.1:1", runId: "r", key: "k", browserMcpScript: BROWSER_MCP_SCRIPT,
  });
  const cfg = servers.playwright!;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env } as Record<string, string>, cwd: dir }));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["browser_snapshot", "browser_click", "browser_take_screenshot", "run_steps"]) assert.ok(names.includes(n), n);

    const html = "<label>Name<input></label><button onclick=\"document.body.insertAdjacentHTML('beforeend','<p>Saved</p>')\">Save</button>";
    await client.callTool({ name: "browser_navigate", arguments: { url: `data:text/html,${encodeURIComponent(html)}` } });

    const batch = await client.callTool({ name: "run_steps", arguments: { steps: [
      { action: "fill", field: "Name", value: "Retail" },
      { action: "click", target: { role: "button", name: "Save" } },
      { action: "waitForText", text: "Saved" },
      { action: "screenshot", filename: "02_saved.png" },
    ] } });
    assert.equal(batch.isError, false, text(batch));
    assert.match(text(batch), /4\. screenshot: OK/);
    assert.ok(existsSync(join(dir, "02_saved.png")), "screenshot saved in the working folder, like browser_take_screenshot");

    // The Playwright tools see what run_steps did: same page.
    const snap = text(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    assert.match(snap, /textbox "Name"[^\n]*: Retail/);
    assert.match(snap, /Saved/);
    assert.doesNotMatch(snap, /Ran Playwright code/, "generated code is left out of responses");

    // A step it cannot perform is an error result Claude can recover from, not a crash.
    const failed = await client.callTool({ name: "run_steps", arguments: { steps: [{ action: "click", target: { role: "button", name: "Delete" }, timeout: 600 }] } });
    assert.equal(failed.isError, true);
    assert.match(text(failed), /not found[\s\S]*browser_snapshot/);

    const invalid = await client.callTool({ name: "run_steps", arguments: { steps: [{ action: "teleport" }] } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});

test("classic mode keeps the plain Playwright MCP command line", () => {
  const servers = mcpServers({
    personas: [{ persona: { id: "p", name: "P" } as never, user: { id: "u", name: "U", username: "u@x" }, stateFile: "s.json", server: "playwright" }],
    runDir: dir, browser: { channel: "chrome", headless: true }, playwrightMcpCli: "cli.js", qaMcpScript: "qa.ts", serverUrl: "http://x", runId: "r", key: "k",
  });
  assert.equal(servers.playwright!.args[0], "cli.js");
  assert.ok(servers.playwright!.args.includes("--storage-state"));
});

test("metrics count turns, tokens, batched actions, fallbacks, snapshots, images and fixed waits", () => {
  const m = new MetricsCollector();
  const use = (id: string, name: string, input: object) => m.onMessage({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, content: unknown, isError = false) => m.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
  use("1", "mcp__playwright__browser_snapshot", {});
  result("1", [{ type: "text", text: "x".repeat(4000) }]);
  use("2", "mcp__playwright__run_steps", { steps: [{}, {}, {}] });
  result("2", "ok");
  use("3", "mcp__playwright_2__run_steps", { steps: [{}] });
  result("3", "stopped", true);
  use("4", "mcp__playwright__browser_click", {});
  use("5", "mcp__playwright__browser_wait_for", { time: 3 });
  use("6", "mcp__playwright__browser_take_screenshot", {});
  result("6", [{ type: "image", source: {} }]);
  use("7", "mcp__qa__record_step", {});
  m.onMessage({ type: "result", num_turns: 9, duration_ms: 1000, total_cost_usd: 0.5, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } });

  const r = m.metrics;
  assert.equal(r.turns, 9);
  assert.deepEqual(r.tokens, { input: 10, cacheCreation: 20, cacheRead: 30, output: 40 });
  assert.equal(r.batches, 2);
  assert.equal(r.batchSteps, 4);
  assert.equal(r.batchFallbacks, 1);
  // 4 batched + click + wait_for (screenshots and snapshots read the page, they do not act on it)
  assert.equal(r.browserActions, 6);
  assert.equal(r.snapshots, 1);
  assert.equal(r.snapshotChars, 4000);
  assert.equal(r.imagesToClaude, 1);
  assert.equal(r.fixedWaits, 1);
  assert.equal(r.fixedWaitSeconds, 3);
  assert.equal(r.toolCalls.record_step, 1);
  assert.equal(r.toolCalls.run_steps, 2);
});

test("hybrid guidance is only in the hybrid prompt, and the evidence and status rules are unchanged", () => {
  const ctx = {
    org: { id: "o", name: "Org", instanceUrl: "https://x.my.salesforce.com", personas: [] } as never,
    persona: { id: "p", name: "Sales" } as never,
    user: { name: "U", username: "u@x" }, displayId: "RUN-20261008-001", testCase: { body: "1. Open Account" }, knownBugs: [],
  };
  const classic = buildPrompt(ctx);
  const hybrid = buildPrompt({ ...ctx, hybrid: true });
  assert.doesNotMatch(classic, /run_steps/);
  assert.match(hybrid, /## Fast execution \(run_steps\)/);
  assert.match(hybrid, /you decide PASS\/FAIL/);
  for (const rule of [/Evidence, for EVERY step/, /record_step rejects a step whose screenshot is missing/, /- PASS: the application behaved/, /- FAIL: the application does not behave/, /- BLOCKED: only when the test cannot be run/, /call finish_test exactly once/]) {
    assert.match(classic, rule);
    assert.match(hybrid, rule);
  }
});
