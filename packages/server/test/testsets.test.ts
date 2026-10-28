import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { changeOf, compareRuns, type Org, type Run, type Verdict } from "@sfqa/shared";
import { buildApp } from "../src/app.ts";
import { RunStore } from "../src/runs/store.ts";
import { SuiteStore } from "../src/suites/store.ts";
import { TestSetService } from "../src/testsets/service.ts";

const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const org: Org = {
  id: "tmcdev", name: "DRIVE-ENERGY-4828 - TMCDEV", loginUrl: "https://test.salesforce.com", instanceUrl: "https://x.lightning.force.com",
  personas: [{ id: "sales", name: "Sales", username: "jeff@rms" }],
};
const cases = [
  { tcId: "TC_013", title: "Invalid data cannot be saved", body: "1. Open Account\n2. Clear Name\n3. Save" },
  { tcId: "TC_014", title: "Account Status values", body: "1. Open Account\n2. Edit Status" },
  { tcId: "TC_016", title: "Data retained after update", body: "1. Update fields\n2. Save" },
];

// Finishes a run the way the runner does: running, one step with the given verdict, finished.
function finishRun(store: RunStore, run: Run, verdict: Verdict): void {
  store.markRunning(run.id);
  const at = new Date().toISOString();
  store.addStep(run.id, { index: 1, label: "1", description: "Step", status: verdict, screenshots: ["01.png"], startedAt: at, finishedAt: at });
  store.finish(run.id);
}

describe("comparing two runs of a set", () => {
  test("each change is named from the previous and the current final result", () => {
    assert.equal(changeOf("PASS", "FAIL"), "New failure");
    assert.equal(changeOf("FAIL", "BLOCKED"), "Still failing");
    assert.equal(changeOf("FAIL", "PASS"), "Fixed");
    assert.equal(changeOf("FLAKY", "PASS"), "Fixed");
    assert.equal(changeOf("PASS", "PASS"), "Passing");
    assert.equal(changeOf("PASS", "FLAKY"), "Flaky");
    assert.equal(changeOf(undefined, "PASS"), "New");
    assert.equal(changeOf(undefined, "FAIL"), "New failure");
    assert.equal(changeOf("PASS", "ERROR"), "Not run");
  });

  test("cases are matched by TC ID and counted per change", () => {
    const run = (finals: Record<string, "PASS" | "FAIL" | "BLOCKED" | "FLAKY">, suiteId: string) => ({
      suiteId, startedAt: "", finishedAt: "x", fast: false, recheck: true,
      results: Object.entries(finals).map(([tcId, final]) => ({ tcId, title: tcId, final, bugs: [] })),
    });
    const c = compareRuns(run({ A: "FAIL", B: "PASS", C: "FLAKY", D: "PASS" }, "S2"), run({ A: "PASS", B: "FAIL", C: "PASS" }, "S1"));
    assert.deepEqual(c.rows.map((r) => `${r.tcId}:${r.change}`), ["A:New failure", "B:Fixed", "C:Flaky", "D:New"]);
    assert.deepEqual(c.counts, { "New failure": 1, Fixed: 1, Flaky: 1, New: 1 });
    assert.equal(c.previous, "S1");
  });
});

describe("re-checks and test sets", () => {
  let dir: string;
  let app: FastifyInstance;
  let store: RunStore;
  let testSets: TestSetService;
  const queued: Run[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-sets-"));
    await writeFile(join(dir, "orgs.json"), JSON.stringify({ orgs: [org] }));
    store = new RunStore();
    const suites = new SuiteStore(store);
    testSets = new TestSetService({ qaRoot: join(dir, "qa"), suites, runs: store });
    app = await buildApp({
      token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: join(dir, "auth"), runsDir: join(dir, "runs"),
      store, suites, testSets, onRunCreated: (run) => queued.push(run), logger: false,
    });
    await app.ready();
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth, ...(payload !== undefined && { payload: payload as object }) });

  test("a batch with re-check runs each FAIL/BLOCKED case once more; passing then = flaky, failing again = confirmed", async () => {
    queued.length = 0;
    const res = await call("POST", "/suites", { orgId: org.id, defaultPersonaId: "sales", recheck: true, cases });
    assert.equal(res.statusCode, 202);
    const suiteId = res.json().id;
    const [a, b, c] = [...queued];
    finishRun(store, a!, "FAIL");
    finishRun(store, b!, "PASS");
    finishRun(store, c!, "BLOCKED");
    // Two re-checks queued (for the FAIL and the BLOCKED case), none for the PASS, each tagged.
    const rechecks = queued.slice(3);
    assert.equal(rechecks.length, 2);
    assert.deepEqual(rechecks.map((r) => r.request.recheckOf), [a!.id, c!.id]);
    assert.ok(rechecks.every((r) => r.request.suiteId === suiteId && r.request.testCase.title === `${cases[rechecks.indexOf(r) === 0 ? 0 : 2]!.tcId} - ${cases[rechecks.indexOf(r) === 0 ? 0 : 2]!.title}`));
    let suite = (await call("GET", `/suites/${suiteId}`)).json();
    assert.equal(suite.summary.pending, 2, "a case is pending while its re-check runs");

    finishRun(store, rechecks[0]!, "PASS");
    finishRun(store, rechecks[1]!, "BLOCKED");
    assert.equal(queued.length, 5, "a re-check is never re-checked");
    suite = (await call("GET", `/suites/${suiteId}`)).json();
    assert.deepEqual(suite.items.map((i: { tcId: string; outcome?: string; verdict?: string }) => `${i.tcId}:${i.outcome ?? i.verdict}`), ["TC_013:flaky", "TC_014:PASS", "TC_016:confirmed"]);
    assert.deepEqual({ ...suite.summary }, { total: 3, passed: 1, failed: 0, blocked: 1, errors: 0, cancelled: 0, pending: 0, flaky: 1 });
  });

  test("without re-check, failures are not run again", async () => {
    queued.length = 0;
    await call("POST", "/suites", { orgId: org.id, defaultPersonaId: "sales", cases: cases.slice(0, 1) });
    finishRun(store, queued[0]!, "FAIL");
    assert.equal(queued.length, 1);
  });

  test("save, list and protect test sets; names are unique per org", async () => {
    const created = await call("POST", "/test-sets", { name: "RMS Account sanity", kind: "Sanity", orgId: org.id, defaultPersonaId: "sales", cases });
    assert.equal(created.statusCode, 201);
    assert.match(created.json().id, /^TS-\d{8}-\d{6}/);
    assert.equal((await call("POST", "/test-sets", { name: "rms account SANITY", kind: "Regression", orgId: org.id, cases })).statusCode, 409);
    assert.equal((await call("POST", "/test-sets", { name: "", kind: "Sanity", orgId: org.id, cases })).statusCode, 400);
    assert.equal((await call("POST", "/test-sets", { name: "X", kind: "Smoke", orgId: org.id, cases })).statusCode, 400);
    const list = (await call("GET", `/test-sets?orgId=${org.id}`)).json().testSets;
    assert.deepEqual(list.map((s: { name: string; kind: string; cases: unknown[] }) => `${s.kind}:${s.name}:${s.cases.length}`), ["Sanity:RMS Account sanity:3"]);
    assert.deepEqual((await call("GET", "/test-sets?orgId=other-org")).json().testSets, []);
  });

  test("running a set twice: final results after re-checks are saved, and the second run is compared with the first", async () => {
    const set = (await call("GET", `/test-sets?orgId=${org.id}`)).json().testSets[0];

    // Run 1: TC_013 FAIL then FAIL (confirmed), TC_014 PASS, TC_016 FAIL then PASS (flaky).
    queued.length = 0;
    const r1 = await call("POST", `/test-sets/${set.id}/run`, { fast: true });
    assert.equal(r1.statusCode, 202);
    assert.equal((await call("POST", `/test-sets/${set.id}/run`, {})).statusCode, 409, "a set cannot run twice at once");
    finishRun(store, queued[0]!, "FAIL");
    finishRun(store, queued[1]!, "PASS");
    finishRun(store, queued[2]!, "FAIL");
    finishRun(store, queued[3]!, "FAIL");
    finishRun(store, queued[4]!, "PASS");
    await new Promise((r) => setTimeout(r, 50));
    let saved = (await call("GET", `/test-sets/${set.id}`)).json();
    assert.equal(saved.runs.length, 1);
    assert.ok(saved.runs[0].finishedAt);
    assert.equal(saved.runs[0].fast, true);
    assert.equal(saved.runs[0].recheck, true, "re-check is on by default for sets");
    assert.deepEqual(saved.runs[0].results.map((r: { tcId: string; final: string }) => `${r.tcId}:${r.final}`), ["TC_013:FAIL", "TC_014:PASS", "TC_016:FLAKY"]);

    // Run 2: TC_013 now passes (fixed), TC_014 fails twice (new failure), TC_016 passes.
    queued.length = 0;
    await call("POST", `/test-sets/${set.id}/run`, { recheck: true });
    finishRun(store, queued[0]!, "PASS");
    finishRun(store, queued[1]!, "FAIL");
    finishRun(store, queued[2]!, "PASS");
    finishRun(store, queued[3]!, "FAIL");
    await new Promise((r) => setTimeout(r, 50));
    saved = (await call("GET", `/test-sets/${set.id}`)).json();
    assert.equal(saved.runs.length, 2, "newest first");
    assert.deepEqual(saved.comparison.rows.map((r: { tcId: string; previous: string; now: string; change: string }) => `${r.tcId}:${r.previous}->${r.now}:${r.change}`),
      ["TC_013:FAIL->PASS:Fixed", "TC_014:PASS->FAIL:New failure", "TC_016:FLAKY->PASS:Fixed"]);
    assert.deepEqual(saved.comparison.counts, { Fixed: 2, "New failure": 1 });
  });

  test("a run still going when the server stopped is marked interrupted, not compared", async () => {
    const created = (await call("POST", "/test-sets", { name: "Interrupted", kind: "Regression", orgId: org.id, defaultPersonaId: "sales", cases: cases.slice(0, 1) })).json();
    queued.length = 0;
    await call("POST", `/test-sets/${created.id}/run`, {});
    // A new service instance = a restarted server: it no longer knows the running batch.
    const restarted = new TestSetService({ qaRoot: join(dir, "qa"), suites: new SuiteStore(new RunStore()), runs: new RunStore() });
    const set = (await restarted.get(created.id))!;
    assert.equal(set.runs[0]!.interrupted, true);
    assert.equal(set.comparison, undefined);
  });

  test("deleting a set removes only the set file", async () => {
    const created = (await call("POST", "/test-sets", { name: "To delete", kind: "Sanity", orgId: org.id, defaultPersonaId: "sales", cases: cases.slice(0, 1) })).json();
    const file = join(dir, "qa", "test-sets", org.id, `${created.id}.json`);
    assert.ok(existsSync(file));
    assert.equal((await call("DELETE", `/test-sets/${created.id}`)).statusCode, 204);
    assert.ok(!existsSync(file));
    assert.equal((await call("DELETE", `/test-sets/${created.id}`)).statusCode, 404);
    assert.equal((await call("GET", `/test-sets/${created.id}`)).statusCode, 404);
  });
});
