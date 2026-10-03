import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun } from "../src/runs/runner.ts";
import { RunStore } from "../src/runs/store.ts";

// Paths that fail before Login As. The Login As path itself is checked against a real org.
let dir: string;
const config = {
  orgs: [{
    id: "uat",
    name: "UAT",
    loginUrl: "https://acme--uat.sandbox.my.salesforce.com",
    instanceUrl: "https://acme--uat.sandbox.lightning.force.com",
    personas: [{ id: "rep", name: "Sales Rep", username: "rep@acme.uat" }],
  }],
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sfqa-runner-"));
  await writeFile(join(dir, "orgs.json"), JSON.stringify(config));
});
after(() => rm(dir, { recursive: true, force: true }));

const deps = (store: RunStore) => ({
  store,
  orgsConfigPath: join(dir, "orgs.json"),
  authDir: join(dir, "auth"),
  runsDir: join(dir, "runs"),
  browser: { channel: "chrome", headless: true },
});

test("org not connected gives a BLOCKED step with connect instructions, and run.json is written", async () => {
  const store = new RunStore();
  const run = store.create({ orgId: "uat", personaId: "rep", testCase: { body: "x" } });
  await executeRun(run.id, deps(store));

  const done = store.get(run.id)!;
  assert.equal(done.status, "completed");
  assert.equal(done.verdict, "BLOCKED");
  assert.match(done.steps[0]?.actual ?? "", /not connected yet/);
  assert.match(done.steps[0]?.actual ?? "", /npm run connect -- --org uat/);

  const saved = JSON.parse(await readFile(join(dir, "runs", run.id, "run.json"), "utf8"));
  assert.equal(saved.verdict, "BLOCKED");
});

test("persona removed from config marks the run as error", async () => {
  const store = new RunStore();
  const run = store.create({ orgId: "uat", personaId: "gone", testCase: { body: "x" } });
  await executeRun(run.id, deps(store));
  const done = store.get(run.id)!;
  assert.equal(done.status, "error");
  assert.match(done.error ?? "", /no longer in config/);
});
