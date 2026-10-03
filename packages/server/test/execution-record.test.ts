import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@sfqa/shared";
import { executionRecord } from "../src/runs/runner.ts";

const at = "2026-10-01T06:05:00.000Z";
const step = (index: number, status: "PASS" | "FAIL" | "BLOCKED", screenshots: string[]) => ({
  index, label: String(index), description: `Step ${index}`, status, actual: `result ${index}`, screenshots, startedAt: at, finishedAt: at,
});
const run: Run = {
  id: "b140730a-9561-4aab-8b67-ffbb7adb3592",
  displayId: "RUN-20261001-006",
  request: { orgId: "o", personaId: "p", testCase: { body: "TC_014\tAccount\t1. Open\t2. Edit" } },
  status: "running",
  steps: [step(0, "PASS", ["00_login.png"]), step(1, "PASS", ["01_open.png"]), step(2, "FAIL", ["03_edit.png"]), step(3, "BLOCKED", ["03_edit.png"])],
  bugs: [{ id: "BUG-001", title: "Not editable", severity: "Medium" }],
  createdAt: at,
  startedAt: at,
};
const org = { id: "o", name: "TMCDEV", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas: [] };
const persona = { id: "p", name: "Sales", userFullName: "Jeff Kraft" };

test("each screenshot is listed once, captioned by its first step, with bug-only evidence appended", () => {
  const rec = executionRecord({ run, displayId: "RUN-20261001-006", org, persona, otherScreenshots: ["03_edit.png", "02_more_actions.png", "01_open.png", "00_login.png"] });
  assert.deepEqual(rec.screenshots.map((s) => s.file.split("/").pop()), ["00_login.png", "01_open.png", "03_edit.png", "02_more_actions.png"]);
  assert.equal(rec.screenshots[2]!.caption, "Step 2: Step 2");
  assert.equal(rec.screenshots[3]!.caption, "more actions");
  assert.ok(rec.screenshots.every((s) => s.file.startsWith("../Screenshots/RUN-20261001-006/")));
});

test("the record uses the run's verdict rule and RMS QA field names", () => {
  const rec = executionRecord({ run, displayId: "RUN-20261001-006", org, persona, adminName: "Mayank Jain" });
  assert.equal(rec.status, "FAIL");
  assert.equal(rec.testCaseId, "TC_014");
  assert.equal(rec.persona, "Sales (Jeff Kraft)");
  assert.equal(rec.executedBy, "Claude Code via Playwright MCP (Login As Jeff Kraft, session of Mayank Jain)");
  assert.deepEqual(rec.bugs, ["BUG-001"]);
  assert.deepEqual(rec.steps[2], { n: "2", action: "Step 2", status: "FAIL", result: "result 2" });
});
