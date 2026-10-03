import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrgsConfig, Run, RunEvent, RunRequest, SlugId, overallVerdict } from "../src/index.ts";

const now = new Date().toISOString();
const runId = "3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f";

test("config/orgs.example.json matches OrgsConfig", () => {
  const raw = readFileSync(join(import.meta.dirname, "../../../config/orgs.example.json"), "utf8");
  const result = OrgsConfig.safeParse(JSON.parse(raw));
  assert.ok(result.success, result.error?.message);
});

test("SlugId rejects path traversal and uppercase", () => {
  for (const bad of ["../etc", "a/b", "Admin", "", "-lead", "a b"]) {
    assert.equal(SlugId.safeParse(bad).success, false, bad);
  }
  assert.equal(SlugId.safeParse("sales-rep-2").success, true);
});

test("OrgsConfig rejects duplicate org and persona ids", () => {
  const persona = { id: "rep", name: "Rep" };
  const org = {
    id: "uat",
    name: "UAT",
    loginUrl: "https://test.salesforce.com",
    instanceUrl: "https://x.lightning.force.com",
    personas: [persona],
  };
  assert.equal(OrgsConfig.safeParse({ orgs: [org, org] }).success, false);
  assert.equal(OrgsConfig.safeParse({ orgs: [{ ...org, personas: [persona, persona] }] }).success, false);
  assert.equal(OrgsConfig.safeParse({ orgs: [org] }).success, true);
});

test("Org requires https URLs", () => {
  const result = OrgsConfig.safeParse({
    orgs: [{ id: "uat", name: "UAT", loginUrl: "http://test.salesforce.com", instanceUrl: "https://x.my.salesforce.com", personas: [{ id: "rep", name: "Rep" }] }],
  });
  assert.equal(result.success, false);
});

test("RunRequest rejects blank test case body", () => {
  const result = RunRequest.safeParse({ orgId: "uat", personaId: "rep", testCase: { body: "   " } });
  assert.equal(result.success, false);
});

test("Run parses and defaults steps and screenshots", () => {
  const run = Run.parse({
    id: runId,
    request: { orgId: "uat", personaId: "rep", testCase: { body: "Create a lead" } },
    status: "queued",
    createdAt: now,
  });
  assert.deepEqual(run.steps, []);

  const withStep = Run.parse({
    ...run,
    steps: [{ index: 0, description: "Open Leads", status: "PASS", startedAt: now, finishedAt: now }],
  });
  assert.deepEqual(withStep.steps[0]?.screenshots, []);
});

test("RunEvent discriminates by type", () => {
  const event = RunEvent.parse({ type: "run.log", runId, level: "info", message: "hi", at: now });
  assert.equal(event.type, "run.log");
  assert.equal(RunEvent.safeParse({ type: "run.unknown", runId }).success, false);
});

test("overallVerdict: FAIL beats BLOCKED beats PASS; empty is BLOCKED", () => {
  assert.equal(overallVerdict([]), "BLOCKED");
  assert.equal(overallVerdict([{ status: "PASS" }, { status: "PASS" }]), "PASS");
  assert.equal(overallVerdict([{ status: "PASS" }, { status: "BLOCKED" }]), "BLOCKED");
  assert.equal(overallVerdict([{ status: "BLOCKED" }, { status: "FAIL" }]), "FAIL");
});

test("overallVerdict ignores N/A steps; only-N/A is BLOCKED", () => {
  assert.equal(overallVerdict([{ status: "PASS" }, { status: "N/A" }]), "PASS");
  assert.equal(overallVerdict([{ status: "N/A" }]), "BLOCKED");
});

test("an agent-declared verdict can make the result worse but never hide a failure", () => {
  assert.equal(overallVerdict([{ status: "PASS" }], "FAIL"), "FAIL");
  assert.equal(overallVerdict([{ status: "PASS" }], "BLOCKED"), "BLOCKED");
  assert.equal(overallVerdict([{ status: "FAIL" }], "PASS"), "FAIL");
});
