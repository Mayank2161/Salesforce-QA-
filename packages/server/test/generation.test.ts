import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Org } from "@sfqa/shared";
import { AgentBridge } from "../src/agent/bridge.ts";
import type { runClaude } from "../src/agent/claude.ts";
import { GenerationService, storyKeyOf } from "../src/generation/service.ts";
import { QA_TEMPLATES_DIR } from "../src/paths.ts";
import { ProjectStore } from "../src/projects/store.ts";
import { readRows, toSuite } from "../src/suites/parse.ts";

type Call = [kind: string, body: unknown];
type Reply = { status: number; message: string };

// Plays tool calls through the bridge exactly as story-mcp would, using the key from mcp.json.
function scripted(bridge: AgentBridge, calls: Call[], replies: Reply[], seen?: { prompt?: string; tools?: string[] }): typeof runClaude {
  return async (opts) => {
    if (seen) { seen.prompt = opts.prompt; seen.tools = opts.allowedTools; }
    const env = JSON.parse(await readFile(opts.mcpConfigPath, "utf8")).mcpServers.qa.env;
    for (const [kind, body] of calls) replies.push(await bridge.dispatch(env.SFQA_RUN_ID, env.SFQA_RUN_KEY, kind, body));
    return { ok: true, turns: calls.length };
  };
}

const org: Org = {
  id: "drive-energy-4828-uat", name: "DRIVE-ENERGY-4828 - UAT", loginUrl: "https://x", instanceUrl: "https://x.lightning.force.com",
  personas: [{ id: "sales", name: "Sales", userFullName: "Jeff Kraft", profile: "RMS Sales" }, { id: "sales-manager", name: "Sales Manager" }],
};

const STORY = `RMS-142 Opportunity: PO Received stage requires a PO number
As a Sales user I want the PO Number to be required when the Opportunity reaches "PO Received" so that orders can be booked.
Acceptance criteria:
1. Moving an Opportunity to PO Received without a PO Number shows "PO Number is required".
2. PO Number accepts up to 20 characters.
3. Only Sales Managers can move an Opportunity back from PO Received.`;

const kase = (scenario: string, criteria: string[], type = "Negative", steps = ["Open Opportunity QA Opp 1", "Set Stage to PO Received", "Click Save"]) => ({
  module: "Opportunity", scenario, description: `Checks ${scenario}`, type, priority: "High", persona: "Sales",
  preconditions: "Opportunity QA Opp 1 at stage Quote Sent", steps, testData: "PO Number blank", expected: 'Error "PO Number is required"; stage unchanged', criteria,
});

describe("generating test cases from a Jira story", () => {
  let dir: string;
  let projects: ProjectStore;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-gen-"));
    projects = new ProjectStore(join(dir, "QA-Workspace"), QA_TEMPLATES_DIR);
    await projects.ensure();
    await projects.create("RMS");
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const service = (bridge: AgentBridge, fake: typeof runClaude) => new GenerationService({
    bridge, claude: { command: "claude", model: "sonnet", maxTurns: 150, timeoutMs: 60_000 }, serverUrl: "http://127.0.0.1:1",
    storyMcpScript: "story-mcp.ts", workDir: join(dir, "runs"), qaRoot: join(dir, "qa"), projects, runClaude: fake,
  });

  test("criteria, test cases with traceability, duplicates skipped, uncovered criteria reported, nothing executed", async () => {
    const bridge = new AgentBridge();
    const replies: Reply[] = [];
    const seen: { prompt?: string; tools?: string[] } = {};
    const gens = service(bridge, scripted(bridge, [
      ["cases", { cases: [kase("Too early", ["AC1"])] }],
      ["criteria", { criteria: [{ id: "AC1", text: "PO Number required at PO Received" }, { id: "AC2", text: "PO Number max 20 characters" }, { id: "AC3", text: "Only managers move back" }] }],
      ["cases", { cases: [kase("Unknown criterion", ["AC9"])] }],
      ["cases", { cases: [
        kase("Blank PO Number blocks PO Received", ["AC1"]),
        kase("PO Number with 21 characters is rejected", ["AC2"], "Boundary", ["Open Opportunity QA Opp 1", "Enter a 21-character PO Number", "Click Save"]),
        kase("PO Number with 20 characters is accepted", ["AC2"], "Boundary", ["Open Opportunity QA Opp 1", "Enter a 20-character PO Number", "Click Save"]),
        kase("blank po number blocks PO received!", ["AC1"]),
      ] }],
      ["generationDone", { summary: "Covers the PO Number rule.", gaps: ["Exact length error message not given"], assumptions: ["Length is counted in characters"], questions: ["Which error text for 21 characters?"], affectedAreas: ["Opportunity validation rules", "Order booking integration"] }],
    ], replies, seen));

    const started = await gens.start(org, { orgId: org.id, project: "RMS", story: { text: STORY } });
    assert.equal(started.status, "running");
    assert.equal(started.storyKey, "RMS-142", "the Jira key is read from the story when not given");
    await gens.wait(started.id);

    assert.deepEqual(replies.map((r) => r.status), [422, 200, 422, 200, 200]);
    assert.match(replies[0]!.message, /record_criteria first/);
    assert.match(replies[2]!.message, /unknown criteria AC9/);
    assert.match(replies[3]!.message, /Skipped duplicates: blank po number blocks PO received!/);

    const gen = (await gens.get(started.id))!;
    assert.equal(gen.status, "completed");
    assert.deepEqual(gen.cases.map((c) => c.tcId), ["RMS-142_TC_001", "RMS-142_TC_002", "RMS-142_TC_003"]);
    assert.ok(gen.cases.every((c) => c.review === "Pending" && c.storyId === "RMS-142"));
    assert.deepEqual(gen.uncovered, ["AC3"], "a criterion without any case is reported");
    assert.deepEqual(gen.questions, ["Which error text for 21 characters?"]);

    // Claude gets only the story tools (no browser), the story, and the org's persona names.
    assert.deepEqual(seen.tools, ["mcp__qa"]);
    assert.match(seen.prompt!, /Do not execute anything/);
    assert.match(seen.prompt!, /- Sales \(profile: RMS Sales\), user Jeff Kraft/);
    assert.match(seen.prompt!, /more negative cases than positive/);

    // Saved in the project's org folder.
    const saved = join(projects.projectsDir, "RMS", "UAT", "Test Cases", `${gen.id}.json`);
    assert.ok(existsSync(saved));
  });

  test("review: edit, approve and reject are saved; Excel export works and round-trips into the batch upload", async () => {
    const bridge = new AgentBridge();
    const gens = service(bridge, scripted(bridge, [
      ["criteria", { criteria: [{ id: "AC1", text: "PO Number required" }, { id: "AC2", text: "Max 20 characters" }] }],
      ["cases", { cases: [kase("Blank PO Number blocks PO Received", ["AC1"]), kase("21 characters rejected", ["AC2"], "Boundary", ["Open QA Opp 1", "Enter 21 characters", "Save"])] }],
      ["generationDone", { summary: "ok" }],
    ], []));
    const { id } = await gens.start(org, { orgId: org.id, story: { key: "RMS-150", text: STORY } });
    await gens.wait(id);

    const edited = await gens.updateCase(id, "RMS-150_TC_001", { expected: 'Error "PO Number is required" under the field', review: "Approved" });
    assert.equal(edited.edited, true);
    assert.equal(edited.review, "Approved");
    const rejected = await gens.updateCase(id, "RMS-150_TC_002", { review: "Rejected" });
    assert.equal(rejected.edited, undefined, "approving or rejecting alone is not an edit");
    await assert.rejects(gens.updateCase(id, "RMS-150_TC_404", { review: "Approved" }), /no test case/);

    // A new service instance (server restart) reads the saved review.
    const reloaded = (await service(bridge, scripted(bridge, [], [])).get(id))!;
    assert.deepEqual(reloaded.cases.map((c) => c.review), ["Approved", "Rejected"]);

    const all = await gens.exportXlsx(id);
    assert.equal(all.fileName, "RMS-150_TestCases.xlsx");
    const approved = await gens.exportXlsx(id, true);
    const { rows } = await readRows(approved.fileName, Buffer.from(approved.data));
    assert.deepEqual(rows[0]!.slice(0, 6), ["Test Case ID", "Jira Story ID", "Module", "Test Scenario", "Test Case Description", "Test Type"]);
    assert.equal(rows.length, 2, "only the approved case");

    // The exported sheet loads straight into the Excel/CSV batch upload, with the persona matched.
    const suite = toSuite(approved.fileName, rows, org.personas);
    assert.deepEqual(suite.missingColumns, []);
    assert.equal(suite.cases.length, 1);
    const c = suite.cases[0]!;
    assert.equal(c.tcId, "RMS-150_TC_001");
    assert.equal(c.personaId, "sales");
    assert.match(c.body, /1\. Open Opportunity QA Opp 1\n2\. Set Stage to PO Received/);
    assert.match(c.body, /PO Number is required" under the field/);

    // The export is also saved next to the generation.
    const files = await readdir(join(dir, "qa", "test-cases"));
    assert.ok(files.includes(`${id}_RMS-150_TestCases_Approved.xlsx`), files.join(", "));
  });

  test("two Generate requests at the same moment start only one generation", async () => {
    const bridge = new AgentBridge();
    const gens = service(bridge, scripted(bridge, [
      ["criteria", { criteria: [{ id: "AC1", text: "PO Number required" }] }],
      ["cases", { cases: [kase("Blank PO Number blocks PO Received", ["AC1"])] }],
    ], []));
    const results = await Promise.allSettled([
      gens.start(org, { orgId: org.id, story: { text: STORY } }),
      gens.start(org, { orgId: org.id, story: { text: STORY } }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.match((rejected.reason as Error).message, /already being generated/);
    const started = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value;
    await gens.wait(started.id);
  });

  test("generations started in the same second never share an id or overwrite each other", async () => {
    const bridge = new AgentBridge();
    const quick = scripted(bridge, [
      ["criteria", { criteria: [{ id: "AC1", text: "PO Number required" }] }],
      ["cases", { cases: [kase("Blank PO Number blocks PO Received", ["AC1"])] }],
    ], []);
    const gens = service(bridge, quick);
    const a = await gens.start(org, { orgId: org.id, story: { key: "RMS-160", text: STORY } });
    await gens.wait(a.id);
    const b = await gens.start(org, { orgId: org.id, story: { key: "RMS-161", text: STORY } });
    await gens.wait(b.id);
    assert.notEqual(a.id, b.id);
    if (b.id.startsWith(a.id)) assert.match(b.id, /^GEN-[0-9]{8}-[0-9]{6}-2$/, "same second: numbered -2");
    // Both are still there, each with its own story, also after a restart.
    const fresh = service(bridge, quick);
    assert.equal((await fresh.get(a.id))!.storyKey, "RMS-160");
    assert.equal((await fresh.get(b.id))!.storyKey, "RMS-161");
  });

  test("a typed Jira key is made safe for test case ids and file names", async () => {
    assert.equal(storyKeyOf("rms 142"), "RMS-142");
    assert.equal(storyKeyOf("RMS:142"), "RMS-142");
    assert.equal(storyKeyOf("../../evil"), "EVIL");
    assert.equal(storyKeyOf("  "), "STORY");
    const bridge = new AgentBridge();
    const gens = service(bridge, scripted(bridge, [
      ["criteria", { criteria: [{ id: "AC1", text: "PO Number required" }] }],
      ["cases", { cases: [kase("Blank PO Number blocks PO Received", ["AC1"])] }],
    ], []));
    const { id } = await gens.start(org, { orgId: org.id, story: { key: "../../x:y?*", text: STORY } });
    await gens.wait(id);
    const gen = (await gens.get(id))!;
    assert.match(gen.storyKey, /^[A-Z0-9_-]+$/);
    assert.equal(gen.cases[0]!.tcId, `${gen.storyKey}_TC_001`);
    const { fileName } = await gens.exportXlsx(id);
    assert.ok(existsSync(join(dir, "qa", "test-cases", `${id}_${fileName}`)), "the Excel copy is saved next to the generation, not elsewhere");
  });

  test("earlier stories are listed per org (newest first) and can be deleted", async () => {
    const bridge = new AgentBridge();
    const gens = service(bridge, scripted(bridge, [
      ["criteria", { criteria: [{ id: "AC1", text: "PO Number required" }] }],
      ["cases", { cases: [kase("Blank PO Number blocks PO Received", ["AC1"])] }],
    ], []));
    const { id } = await gens.start(org, { orgId: org.id, story: { key: "RMS-170", text: STORY } });
    await gens.wait(id);
    const listed = await gens.list(org.id);
    assert.ok(listed.length >= 2);
    assert.deepEqual(listed[0], { id, storyKey: "RMS-170", createdAt: listed[0]!.createdAt, status: "completed", cases: 1 });
    assert.ok(listed.every((g, i) => i === 0 || g.createdAt <= listed[i - 1]!.createdAt), "newest first");
    assert.deepEqual(await gens.list("another-org"), []);

    await gens.delete(id);
    assert.equal(await gens.get(id), undefined);
    assert.equal(await service(bridge, scripted(bridge, [], [])).get(id), undefined, "gone after a restart too");
    assert.ok(!(await gens.list(org.id)).some((g) => g.id === id));
    await assert.rejects(gens.delete(id), /no generation/);
  });

  test("only one generation at a time; a story without test cases is an error", async () => {
    const bridge = new AgentBridge();
    let release!: () => void;
    let entered!: () => void;
    const claudeStarted = new Promise<void>((r) => { entered = r; });
    const gens = service(bridge, async () => { entered(); await new Promise<void>((r) => { release = r; }); return { ok: false, error: "stopped" }; });
    const first = await gens.start(org, { orgId: org.id, story: { text: STORY } });
    await claudeStarted;
    await assert.rejects(gens.start(org, { orgId: org.id, story: { text: STORY } }), /already being generated/);
    release();
    await gens.wait(first.id);
    const gen = (await gens.get(first.id))!;
    assert.equal(gen.status, "error");
  });
});
