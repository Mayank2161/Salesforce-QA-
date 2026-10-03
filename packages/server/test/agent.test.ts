import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/agent/bridge.ts";
import { claudeArgs, claudeChildEnv, describeToolUse } from "../src/agent/claude.ts";
import { buildPrompt, guessTestCaseId } from "../src/agent/prompt.ts";

const handlers = (log: string[]) => ({
  step: async (r: { n: string | number; status: string }) => (log.push(`step ${r.n} ${r.status}`), "ok-step"),
  bug: async () => "ok-bug",
  finish: async () => "ok-finish",
});

test("bridge only accepts reports with the run's own key", async () => {
  const bridge = new AgentBridge();
  const log: string[] = [];
  const key = bridge.open("run-1", handlers(log));
  const step = { n: 1, action: "Open Accounts", status: "PASS", result: "List shown", screenshot: "01_accounts.png" };

  assert.equal((await bridge.dispatch("run-1", "wrong", "step", step)).status, 403);
  assert.equal((await bridge.dispatch("run-2", key, "step", step)).status, 403);
  assert.deepEqual(await bridge.dispatch("run-1", key, "step", step), { status: 200, message: "ok-step" });
  assert.deepEqual(log, ["step 1 PASS"]);

  bridge.close("run-1");
  assert.equal((await bridge.dispatch("run-1", key, "step", step)).status, 403);
});

test("bridge validates reports and rejects unsafe screenshot names", async () => {
  const bridge = new AgentBridge();
  const key = bridge.open("r", handlers([]));
  const bad = await bridge.dispatch("r", key, "step", { n: 1, action: "a", status: "MAYBE", result: "x" });
  assert.equal(bad.status, 400);
  const traversal = await bridge.dispatch("r", key, "step", { n: 1, action: "a", status: "PASS", result: "x", screenshot: "../../auth/x.png" });
  assert.equal(traversal.status, 400);
  assert.equal((await bridge.dispatch("r", key, "nope", {})).status, 404);
});

test("handler errors are returned to Claude as a 422 message", async () => {
  const bridge = new AgentBridge();
  const key = bridge.open("r", { ...handlers([]), finish: async () => { throw new Error("already finished"); } });
  const res = await bridge.dispatch("r", key, "finish", { status: "PASS", title: "t", expected: "e", actual: "a" });
  assert.deepEqual(res, { status: 422, message: "already finished" });
});

test("the Claude child never gets an API key, so it always uses the signed-in Claude Code account", () => {
  const env = claudeChildEnv({
    PATH: "x", ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_AUTH_TOKEN: "t",
    CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "vscode", CLAUDE_AGENT_SDK_VERSION: "1", USERPROFILE: "C:\\Users\\me",
  });
  assert.deepEqual(env, { PATH: "x", USERPROFILE: "C:\\Users\\me" });
});

test("Claude runs with no built-in tools, only the browser and QA tools, and no --bare", () => {
  const args = claudeArgs({ command: "claude", model: "sonnet", maxTurns: 10, timeoutMs: 1 }, "mcp.json");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 3), ["mcp__playwright", "mcp__qa"]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--bare"), "bare mode ignores the Claude Code login");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
});

test("tool calls are summarised for the live log; snapshots are hidden", () => {
  assert.equal(describeToolUse("mcp__playwright__browser_click", { element: "Save button" }), "click: Save button");
  assert.equal(describeToolUse("mcp__playwright__browser_snapshot"), undefined);
  assert.equal(describeToolUse("mcp__qa__record_step", { n: 3, status: "FAIL" }), "Recording step 3: FAIL");
});

test("the prompt carries persona, rules, known bugs and the test case", () => {
  const prompt = buildPrompt({
    org: { id: "o", name: "RMS - DEV", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas: [] },
    persona: { id: "s", name: "Sales User", profile: "RMS Sales" },
    user: { name: "Jeff Kraft", username: "jeffkraft@rms.com" },
    displayId: "RUN-20261001-001",
    testCase: { title: "TC_034 Stage values", body: "1. Open an opportunity\n2. Check stage list" },
    knownBugs: [{ id: "BUG-003", title: "Closed Lost missing", status: "Open" }],
  });
  for (const s of ["Jeff Kraft (jeffkraft@rms.com)", "Never click \"Log out as", "QA_RUN-20261001-001_", "BUG-003 [Open]", "2. Check stage list", "finish_test exactly once"]) {
    assert.ok(prompt.includes(s), s);
  }
});

test("the prompt makes app-caused failures FAIL with a bug, and keeps BLOCKED for environment problems", () => {
  const prompt = buildPrompt({
    org: { id: "o", name: "O", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas: [] },
    persona: { id: "s", name: "Sales User" },
    user: { name: "J", username: "j@x.com" },
    displayId: "RUN-20261001-001",
    testCase: { body: "x" },
    knownBugs: [],
  });
  assert.match(prompt, /FAIL:[^\n]*field is read-only, hidden or missing[^\n]*report_bug/);
  assert.match(prompt, /BLOCKED: only when the test cannot be run for reasons outside the behaviour under test/);
  assert.match(prompt, /record_step rejects a step whose screenshot is missing/);
  assert.match(prompt, /row copied from a test sheet/);
});

test("test case ids are guessed from the pasted text", () => {
  assert.equal(guessTestCaseId({ title: "TC_008 - Account fields", body: "" }), "TC_008");
  assert.equal(guessTestCaseId({ body: "UAT_041: create opportunity rows" }), "UAT_041");
  assert.equal(guessTestCaseId({ body: "no id here" }), undefined);
});
