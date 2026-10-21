import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentBridge } from "../src/agent/bridge.ts";
import { buildPrompt } from "../src/agent/prompt.ts";
import { BROWSER_MCP_SCRIPT, QA_TEMPLATES_DIR } from "../src/paths.ts";
import { QaWorkspace } from "../src/reports/workspace.ts";
import { browserSettingsFromEnv } from "../src/salesforce/browser.ts";
import { executeRun, mcpServers, recordSteps } from "../src/runs/runner.ts";
import { RunStore } from "../src/runs/store.ts";

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "sfqa-fast-")); });
after(() => rm(dir, { recursive: true, force: true }));

const step = (n: number, screenshot?: string) => ({ n, action: `Step ${n}`, status: "PASS" as const, result: "ok", ...(screenshot && { screenshot }) });

test("record_steps records each step through record_step and stops at the first rejected one", async () => {
  const seen: (string | number)[] = [];
  const recordStep = async (s: { n: string | number; screenshot?: string }) => {
    if (!s.screenshot) throw new Error("Every step needs evidence.");
    seen.push(s.n);
    return "ok";
  };
  assert.equal(await recordSteps({ steps: [step(1, "01_a.png"), step(2, "02_b.png")] }, recordStep), "Recorded steps 1, 2.");
  await assert.rejects(
    recordSteps({ steps: [step(3, "03_c.png"), step(4), step(5, "05_e.png")] }, recordStep),
    /Recorded step\(s\) 3\. Step 4 was NOT recorded: Every step needs evidence\..*record step 4 and the steps after it again/,
  );
  assert.deepEqual(seen, [1, 2, 3], "step 5 is not recorded after step 4 was rejected");

  // Merged steps are refused: each step keeps its own result and screenshot.
  for (const n of ["2-3", "5, 6", "7 and 8", "2–4"]) {
    await assert.rejects(recordSteps({ steps: [{ ...step(1, "01_a.png"), n }] }, recordStep), /combines several steps/, n);
  }
  assert.equal(await recordSteps({ steps: [{ ...step(1, "01_a.png"), n: "5a" }] }, recordStep), "Recorded steps 5a.", "sub-steps like 5a are fine");
});

test("the bridge validates record_steps like record_step (unsafe screenshot names are refused)", async () => {
  const bridge = new AgentBridge();
  const key = bridge.open("r", { steps: async (r) => `got ${r.steps.length}` });
  assert.deepEqual(await bridge.dispatch("r", key, "steps", { steps: [step(1, "01_a.png"), step(2, "02_b.png")] }), { status: 200, message: "got 2" });
  assert.equal((await bridge.dispatch("r", key, "steps", { steps: [step(1, "../../auth/x.png")] })).status, 400);
  assert.equal((await bridge.dispatch("r", key, "steps", { steps: [] })).status, 400);
});

test("fast mode: the prompt offers record_steps and last run's records; evidence and status rules are unchanged", () => {
  const ctx = {
    org: { id: "o", name: "Org", instanceUrl: "https://x.lightning.force.com", personas: [] } as never,
    persona: { id: "p", name: "Sales" } as never,
    user: { name: "U", username: "u@x" }, displayId: "RUN-20261020-001", testCase: { body: "1. Open Account" }, knownBugs: [], hybrid: true,
  };
  const plain = buildPrompt(ctx);
  const fast = buildPrompt({ ...ctx, fast: true, previousRun: { runId: "RUN-20261019-004", status: "PASS", records: "Account Shooting Store (001bc00000jZRwLAAW)" } });
  assert.doesNotMatch(plain, /record_steps/);
  // Fewer reporting calls must never mean fewer checks: later steps are still attempted.
  assert.match(fast, /Recording efficiently never means testing less/);
  assert.match(fast, /A later step is BLOCKED only if no way to perform it exists at all/);
  assert.match(fast, /record_steps records several consecutive steps/);
  assert.match(fast, /RUN-20261019-004, PASS\) used: Account Shooting Store \(001bc00000jZRwLAAW\)/);
  for (const rule of [/Evidence, for EVERY step/, /Each step gets its own screenshot/, /- FAIL: the application does not behave/, /- BLOCKED: only when the test cannot be run/, /call finish_test exactly once/]) {
    assert.match(fast, rule);
  }
});

test("fast mode: the QA tools offer record_steps only when the flag is on; the browser waits for the login", () => {
  const base = {
    personas: [{ persona: { id: "p", name: "P" } as never, user: { id: "u", name: "U", username: "u@x" }, stateFile: "s.json", server: "playwright" }],
    runDir: dir, browser: { channel: "chrome", headless: true }, playwrightMcpCli: "cli.js", qaMcpScript: "qa.ts", serverUrl: "http://x", runId: "r", key: "k", browserMcpScript: "browser-mcp.ts",
  };
  const off = mcpServers(base);
  assert.equal(off.qa!.env!.SFQA_FAST, undefined);
  assert.equal(JSON.parse(off.playwright!.env!.SFQA_BROWSER!).waitForStorageState, undefined);
  const on = mcpServers({ ...base, fast: true, waitForLogin: true });
  assert.equal(on.qa!.env!.SFQA_FAST, "1");
  assert.equal(JSON.parse(on.playwright!.env!.SFQA_BROWSER!).waitForStorageState, true);
});

test("the browser started before the login opens only once the session file is complete", { timeout: 120_000 }, async () => {
  const state = join(dir, "late-state.json");
  const servers = mcpServers({
    personas: [{ persona: { id: "p", name: "P" } as never, user: { id: "u", name: "U", username: "u@x" }, stateFile: state, server: "playwright" }],
    runDir: dir, browser: { ...browserSettingsFromEnv(), headless: true }, playwrightMcpCli: "unused", qaMcpScript: "qa.ts",
    serverUrl: "http://127.0.0.1:1", runId: "r", key: "k", browserMcpScript: BROWSER_MCP_SCRIPT, fast: true, waitForLogin: true,
  });
  const cfg = servers.playwright!;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env } as Record<string, string>, cwd: dir }));
  try {
    const start = Date.now();
    // Half-written file first: still waits.
    setTimeout(() => void writeFile(state, '{"cookies":['), 300);
    setTimeout(() => void writeFile(state, JSON.stringify({ cookies: [], origins: [] })), 1500);
    const res = await client.callTool({ name: "browser_navigate", arguments: { url: "data:text/html,<h1>ready</h1>" } });
    assert.ok(Date.now() - start >= 1400, `opened after ${Date.now() - start} ms`);
    assert.notEqual(res.isError, true);
  } finally {
    await client.close();
  }
});

test("fast mode: when the login fails, the early Claude session is stopped and the run is BLOCKED by the login step only", { timeout: 120_000 }, async () => {
  const config = {
    orgs: [{
      id: "uat", name: "UAT", loginUrl: "https://acme--uat.sandbox.my.salesforce.com", instanceUrl: "https://acme--uat.sandbox.lightning.force.com",
      personas: [{ id: "rep", name: "Sales Rep", username: "rep@acme.uat", userId: "005000000000001AAA", userFullName: "Rep One" }],
    }],
  };
  await writeFile(join(dir, "orgs.json"), JSON.stringify(config));
  const store = new RunStore();
  const qa = new QaWorkspace(join(dir, "qa"), QA_TEMPLATES_DIR);
  await qa.ensure();
  const run = store.create({ orgId: "uat", personaId: "rep", testCase: { body: "1. Open Account" } });
  await executeRun(run.id, {
    store, orgsConfigPath: join(dir, "orgs.json"), authDir: join(dir, "auth"), runsDir: join(dir, "runs"),
    browser: { channel: "chrome", headless: true },
    agent: {
      bridge: new AgentBridge(), qa, serverUrl: "http://127.0.0.1:1", qaMcpScript: "qa.ts", playwrightMcpCli: "cli.js",
      // Stands in for Claude Code (it exits at once). Checks the early start leaves only the login step and
      // no session files; stopping a live Claude session on a failed login is checked against a real org.
      claude: { command: process.execPath, model: "sonnet", maxTurns: 1, timeoutMs: 60_000 },
      hybrid: true, browserMcpScript: BROWSER_MCP_SCRIPT, fast: true,
    },
  });
  const done = store.get(run.id)!;
  assert.equal(done.verdict, "BLOCKED");
  assert.deepEqual(done.steps.map((s) => s.label), ["0"], "only the login step; no 'agent stopped' step");
  assert.match(done.steps[0]!.actual ?? "", /not connected yet/);
  // Nothing of the early session is left behind.
  const left = await readdir(join(dir, "runs", run.id));
  assert.ok(!left.includes("mcp.json") && !left.some((f) => f.startsWith("persona-state")), left.join(", "));
  assert.ok(existsSync(join(dir, "runs", run.id, "run.json")));
});
