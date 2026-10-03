import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QA_TEMPLATES_DIR } from "../src/paths.ts";
import { QaWorkspace, reportTimestamp } from "../src/reports/workspace.ts";

let root: string;
let qa: QaWorkspace;
const day = new Date(2026, 9, 1, 12, 30);

before(async () => {
  root = await mkdtemp(join(tmpdir(), "sfqa-qa-"));
  qa = new QaWorkspace(root, QA_TEMPLATES_DIR);
  await qa.ensure();
});
after(() => rm(root, { recursive: true, force: true }));

const readData = async (file: string, global: string) => {
  const text = await readFile(join(root, file), "utf8");
  return JSON.parse(text.slice(text.indexOf(`window.${global} =`) + `window.${global} =`.length).trim().replace(/;\s*$/, ""));
};

test("ensure creates the RMS-style report pages and empty data files", async () => {
  for (const f of ["reports/Test_Execution_Report.html", "bugs/Bug_Report.html", "assets/qa-report.css", "assets/qa-status.js"]) {
    await readFile(join(root, f));
  }
  assert.deepEqual(await readData("reports/execution-data.js", "TEST_EXECUTIONS"), []);
  assert.deepEqual(await readData("bugs/bug-data.js", "BUG_REPORTS"), []);
});

test("ensure never overwrites existing data", async () => {
  await writeFile(join(root, "bugs/bug-data.js"), 'window.BUG_REPORTS = [{"id":"BUG-007","title":"x"}];\n');
  await qa.ensure();
  assert.equal((await readData("bugs/bug-data.js", "BUG_REPORTS"))[0].id, "BUG-007");
  await writeFile(join(root, "bugs/bug-data.js"), "window.BUG_REPORTS = [];\n");
});

test("run ids are numbered per day and never reused", async () => {
  const a = await qa.nextRunId(day);
  const b = await qa.nextRunId(day);
  assert.equal(a, "RUN-20261001-001");
  assert.equal(b, "RUN-20261001-002");
  assert.equal(await qa.nextRunId(new Date(2026, 9, 2)), "RUN-20261002-001");
});

test("bugs get sequential ids and their screenshots are copied into bugs/<BUG-ID>/", async () => {
  const runId = "RUN-20261001-001";
  await writeFile(join(qa.screenshotsDir(runId), "03_error.png"), "png");
  const base = {
    title: "Stage list missing Closed Lost", severity: "High", status: "Open", linkedRun: runId, linkedTestCase: "TC_034",
    stepsToReproduce: ["Open opportunity"], expected: "Closed Lost listed", actual: "Not listed",
    reproducedIn: [{ run: runId, testCase: "TC_034", on: "now", note: "First found." }],
  };
  const bug = await qa.addBug(base, { displayId: runId, screenshots: [{ file: "03_error.png", caption: "Stage list" }, { file: "missing.png", caption: "x" }, { file: "../evil.png", caption: "x" }] });
  assert.equal(bug.id, "BUG-001");
  assert.deepEqual(bug.attachments, [{ file: "BUG-001/BUG-001_RUN-20261001-001_03_error.png", caption: "Stage list" }]);
  assert.equal(await readFile(join(root, "bugs", "BUG-001", "BUG-001_RUN-20261001-001_03_error.png"), "utf8"), "png");
  assert.equal((await qa.addBug(base, { displayId: runId, screenshots: [] })).id, "BUG-002");
});

test("a reproduction is added to the existing bug", async () => {
  const bug = await qa.addOccurrence("BUG-001", { run: "RUN-20261001-002", testCase: "TC_034", on: "later", note: "Again" }, { displayId: "RUN-20261001-002", screenshots: [] });
  assert.equal(bug?.reproducedIn.length, 2);
  assert.equal(await qa.addOccurrence("BUG-999", { run: "r", testCase: "t", on: "o", note: "n" }, { displayId: "r", screenshots: [] }), undefined);
});

test("executions are appended and readable after the report page saves the file", async () => {
  await qa.appendExecution({ runId: "RUN-20261001-001", testCaseId: "TC_034", title: "t", status: "FAIL", steps: [], screenshots: [], bugs: ["BUG-001"] });
  // The report page's "Save changes to data file" writes header + JSON with a statusHistory.
  const saved = await readData("reports/execution-data.js", "TEST_EXECUTIONS");
  saved[0].status = "RETEST";
  await writeFile(join(root, "reports/execution-data.js"), `// edited\nwindow.TEST_EXECUTIONS = ${JSON.stringify(saved, null, 2)};\n`);
  await qa.appendExecution({ runId: "RUN-20261001-002", testCaseId: "TC_034", title: "t", status: "PASS", steps: [], screenshots: [], bugs: [] });
  const runs = await readData("reports/execution-data.js", "TEST_EXECUTIONS");
  assert.deepEqual(runs.map((r: { status: string }) => r.status), ["RETEST", "PASS"]);
});

test("a corrupt data file is refused, not overwritten", async () => {
  await writeFile(join(root, "bugs/bug-data.js"), "window.BUG_REPORTS = [ { broken");
  await assert.rejects(qa.listBugs(), /not valid JSON/);
  assert.match(await readFile(join(root, "bugs/bug-data.js"), "utf8"), /broken/);
});

test("report timestamps look like the RMS QA ones", () => {
  assert.match(reportTimestamp(day), /^2026-10-01 12:30\b/);
});
