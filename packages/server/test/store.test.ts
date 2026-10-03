import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../src/runs/store.ts";

const request = { orgId: "uat", personaId: "rep", testCase: { body: "x" } };
const at = new Date().toISOString();

test("finish computes verdict from steps", () => {
  const store = new RunStore();
  const run = store.create(request);
  store.markRunning(run.id);
  store.addStep(run.id, { index: 0, description: "a", status: "PASS", screenshots: [], startedAt: at, finishedAt: at });
  store.addStep(run.id, { index: 1, description: "b", status: "FAIL", screenshots: [], startedAt: at, finishedAt: at });
  store.finish(run.id);
  const done = store.get(run.id);
  assert.equal(done?.status, "completed");
  assert.equal(done?.verdict, "FAIL");
  assert.ok(done?.startedAt && done.finishedAt);
});

test("finish with error marks the run as crashed, with no verdict", () => {
  const store = new RunStore();
  const run = store.create(request);
  store.finish(run.id, "browser crashed");
  const done = store.get(run.id);
  assert.equal(done?.status, "error");
  assert.equal(done?.error, "browser crashed");
  assert.equal(done?.verdict, undefined);
});

test("get returns a copy, so callers cannot mutate stored runs", () => {
  const store = new RunStore();
  const run = store.create(request);
  const copy = store.get(run.id)!;
  copy.status = "completed";
  assert.equal(store.get(run.id)?.status, "queued");
});

test("unsubscribe stops delivery", () => {
  const store = new RunStore();
  const run = store.create(request);
  let count = 0;
  const off = store.subscribe(run.id, () => count++);
  store.log(run.id, "info", "one");
  off();
  store.log(run.id, "info", "two");
  assert.equal(count, 1);
});
