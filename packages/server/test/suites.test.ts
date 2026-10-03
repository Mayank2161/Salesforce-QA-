import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Persona, Run } from "@sfqa/shared";
import { buildApp } from "../src/app.ts";
import { RunStore } from "../src/runs/store.ts";
import { parseCsv } from "../src/suites/csv.ts";
import { SuiteFileError, matchPersona, readRows, toSuite } from "../src/suites/parse.ts";
import { CANCELLED, SuiteStore } from "../src/suites/store.ts";
import { makeXlsx } from "./helpers/xlsx.ts";

const personas: Persona[] = [
  { id: "sales", name: "Sales", userFullName: "Jeff Kraft", profile: "Sales" },
  { id: "executive", name: "executive", userFullName: "Zack Farber", profile: "Sales" },
  { id: "system-administrator", name: "System Administrator", userFullName: "Mayank Jain", profile: "System Administrator" },
];

const HEADER = ["Sprint", "Story", "TC ID", "Module", "Title", "Persona", "Description", "Pre-Req", "Type", "Priority", "Steps", "Expected Result", "Actual Result", "Status"];
const row = (tc: string, persona: string, extra: Partial<Record<"steps" | "expected" | "title", string>> = {}) => [
  "Sprint 1", "RMS 14", tc, "Account", extra.title ?? `Title ${tc}`, persona, "desc", "Existing Account", "Positive", "High",
  extra.steps ?? "1. Open an Account\n2. Click Edit", extra.expected ?? "Values are retained", "old actual", "Pass",
];

describe("parsing", () => {
  test("reads an Excel file with a title row above the header", async () => {
    const xlsx = makeXlsx([["RMS Sprint 1 test cases"], HEADER, row("TC_008", "Sales User"), row("TC_009", "Executive"), row("TC_010", "")]);
    const { rows, sheet } = await readRows("cases.xlsx", xlsx);
    const suite = toSuite("cases.xlsx", rows, personas, sheet);
    assert.equal(suite.sheet, "Test Cases");
    assert.deepEqual(suite.missingColumns, []);
    assert.deepEqual(suite.cases.map((c) => [c.row, c.tcId, c.module, c.personaId]), [[3, "TC_008", "Account", "sales"], [4, "TC_009", "Account", "executive"], [5, "TC_010", "Account", undefined]]);
  });

  test("each row becomes labelled test case text; old results are ignored", async () => {
    const { rows } = await readRows("c.xlsx", makeXlsx([HEADER, row("TC_008", "Sales User")]));
    const [c] = toSuite("c.xlsx", rows, personas).cases;
    assert.match(c!.body, /^TC ID: TC_008\nSprint: Sprint 1\nStory: RMS 14\nModule: Account\nTitle: Title TC_008\nPersona: Sales User/);
    assert.match(c!.body, /Pre-Req:\nExisting Account/);
    assert.match(c!.body, /Steps:\n1\. Open an Account\n2\. Click Edit\nExpected Result:\nValues are retained$/);
    assert.doesNotMatch(c!.body, /old actual|Status: Pass/);
  });

  test("missing required columns are named and no cases are returned", () => {
    const suite = toSuite("c.csv", [["TC ID", "Module", "Description"], ["TC_1", "Account", "x"]], personas);
    assert.deepEqual(suite.missingColumns, ["Title", "Steps", "Expected Result"]);
    assert.deepEqual(suite.cases, []);
    assert.deepEqual(toSuite("c.csv", [["Name", "Notes"]], personas).missingColumns, ["TC ID", "Title", "Steps", "Expected Result"]);
  });

  test("rows without TC ID, steps or expected result are invalid; blank rows are skipped", () => {
    const suite = toSuite("c.csv", [HEADER, row("", "Sales"), [], row("TC_2", "Sales", { steps: "" }), row("TC_3", "Sales", { expected: "" }), row("TC_4", "Sales")], personas);
    assert.deepEqual(suite.cases.map((c) => [c.row, c.error]), [
      [2, "No TC ID in this row."], [4, "No Steps in this row."], [5, "No Expected Result in this row."], [6, undefined],
    ]);
  });

  test("unknown persona and duplicate TC IDs are warnings, not errors", () => {
    const suite = toSuite("c.csv", [HEADER, row("TC_1", "Finance Manager"), row("TC_1", "Sales")], personas);
    assert.match(suite.cases[0]!.warning!, /"Finance Manager" does not match/);
    assert.equal(suite.cases[0]!.personaId, undefined);
    assert.match(suite.cases[1]!.warning!, /Duplicate TC ID \(also in row 2\)/);
    assert.ok(suite.cases.every((c) => !c.error));
  });

  test("header spellings are matched loosely", () => {
    const suite = toSuite("c.csv", [["Test Case ID", "Test Case Title", "Test Steps", "Expected", "Precondition"], ["UAT_021", "Budget", "1. Go", "Done", "Account exists"]], personas);
    assert.deepEqual(suite.missingColumns, []);
    assert.equal(suite.cases[0]!.tcId, "UAT_021");
    assert.match(suite.cases[0]!.body, /Pre-Req:\nAccount exists/);
  });

  test("persona matching: exact name, profile or user, then one unambiguous partial match", () => {
    assert.equal(matchPersona("Sales User", personas)?.id, "sales");
    assert.equal(matchPersona("EXECUTIVE", personas)?.id, "executive");
    assert.equal(matchPersona("Zack Farber", personas)?.id, "executive");
    assert.equal(matchPersona("System Admin", personas)?.id, "system-administrator");
    assert.equal(matchPersona("Finance", personas), undefined);
    assert.equal(matchPersona("", personas), undefined);
  });

  test("CSV: quoted multi-line cells, doubled quotes, BOM and semicolon delimiter", () => {
    assert.deepEqual(parseCsv('﻿TC ID,Steps\r\nTC_1,"1. Open\n2. Say ""hi"""\r\n'), [["TC ID", "Steps"], ["TC_1", '1. Open\n2. Say "hi"']]);
    assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
  });

  test("bad files give clear errors", async () => {
    await assert.rejects(readRows("cases.xls", Buffer.from("x")), /Save As > Excel Workbook \(\.xlsx\)/);
    await assert.rejects(readRows("cases.pdf", Buffer.from("x")), /Upload an Excel \.xlsx or a \.csv/);
    await assert.rejects(readRows("cases.xlsx", Buffer.from("not a zip")), (e: unknown) => e instanceof SuiteFileError && /not a readable Excel/.test(e.message));
    await assert.rejects(readRows("cases.csv", Buffer.alloc(0)), /empty/);
  });
});

describe("suite store", () => {
  test("statuses come from the runs; cancel only affects rows not started", () => {
    const runs = new RunStore();
    const suites = new SuiteStore(runs);
    const mk = () => runs.create({ orgId: "o", personaId: "sales", testCase: { body: "x" } });
    const [a, b, c] = [mk(), mk(), mk()];
    const id = suites.create("o", "f.xlsx", [a, b, c].map((r, i) => ({ tcId: `TC_${i}`, title: "t", personaId: "sales", personaName: "Sales", runId: r.id })), new Date(2026, 9, 1, 14, 5, 9));
    assert.equal(id, "SUITE-20261001-140509");

    runs.markRunning(a.id);
    runs.addStep(a.id, { index: 0, description: "login", status: "PASS", screenshots: [], startedAt: a.createdAt, finishedAt: a.createdAt });
    assert.equal(suites.cancel(id), 2);
    runs.finish(a.id);

    const s = suites.get(id)!;
    assert.deepEqual(s.items.map((i) => [i.tcId, i.status, i.verdict]), [["TC_0", "completed", "PASS"], ["TC_1", "cancelled", undefined], ["TC_2", "cancelled", undefined]]);
    assert.deepEqual(s.summary, { total: 3, passed: 1, failed: 0, blocked: 0, errors: 0, cancelled: 2, pending: 0 });
    assert.equal(runs.get(b.id)?.error, CANCELLED);
  });
});

describe("suite API", () => {
  const TOKEN = "test-token-0123456789";
  const auth = { authorization: `Bearer ${TOKEN}` };
  let dir: string;
  let app: FastifyInstance;
  const started: Run[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-suite-"));
    await writeFile(join(dir, "orgs.json"), JSON.stringify({
      orgs: [{ id: "tmcdev", name: "TMCDEV", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas }],
    }));
    app = await buildApp({ token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: dir, runsDir: dir, logger: false, onRunCreated: (r) => started.push(r) });
    await app.ready();
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth, payload });

  test("parse returns detected rows without running anything", async () => {
    const data = makeXlsx([HEADER, row("TC_008", "Sales User"), row("", "Sales")]).toString("base64");
    const res = await post("/suites/parse", { orgId: "tmcdev", fileName: "cases.xlsx", data });
    assert.equal(res.statusCode, 200);
    const suite = res.json();
    assert.equal(suite.cases.length, 2);
    assert.equal(suite.cases[1].error, "No TC ID in this row.");
    assert.equal(started.length, 0);
  });

  test("an invalid file is a 422 with a clear message", async () => {
    const res = await post("/suites/parse", { orgId: "tmcdev", fileName: "cases.xlsx", data: Buffer.from("nope").toString("base64") });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /not a readable Excel/);
  });

  test("starting a batch queues one run per case, in order, tagged with the batch", async () => {
    const cases = [
      { tcId: "TC_008", title: "Fields", module: "Account", personaId: "sales", body: "TC ID: TC_008\nSteps:\n1. x" },
      { tcId: "TC_009", title: "Budget", body: "TC ID: TC_009\nSteps:\n1. y" },
    ];
    const res = await post("/suites", { orgId: "tmcdev", fileName: "cases.xlsx", defaultPersonaId: "executive", cases });
    assert.equal(res.statusCode, 202);
    const suite = res.json();
    assert.deepEqual(suite.items.map((i: { tcId: string; personaId: string; status: string }) => [i.tcId, i.personaId, i.status]), [["TC_008", "sales", "queued"], ["TC_009", "executive", "queued"]]);
    assert.deepEqual(started.map((r) => r.request.testCase.title), ["TC_008 - Fields", "TC_009 - Budget"]);
    assert.ok(started.every((r) => r.request.suiteId === suite.id));
    assert.deepEqual(suite.summary, { total: 2, passed: 0, failed: 0, blocked: 0, errors: 0, cancelled: 0, pending: 2 });

    const got = await app.inject({ url: `/suites/${suite.id}`, headers: auth });
    assert.equal(got.json().id, suite.id);
    const cancel = await post(`/suites/${suite.id}/cancel`, {});
    assert.equal(cancel.json().cancelled, 2);
    assert.equal(cancel.json().suite.summary.cancelled, 2);
  });

  test("a batch with a row that has no persona and no default is refused before anything is queued", async () => {
    const before = started.length;
    const res = await post("/suites", { orgId: "tmcdev", cases: [{ tcId: "TC_1", title: "t", personaId: "sales", body: "b" }, { tcId: "TC_2", title: "t", body: "b" }] });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /TC_2/);
    assert.equal(started.length, before);
  });

  test("unknown batch is 404", async () => {
    assert.equal((await app.inject({ url: "/suites/SUITE-20260101-000000", headers: auth })).statusCode, 404);
  });
});
