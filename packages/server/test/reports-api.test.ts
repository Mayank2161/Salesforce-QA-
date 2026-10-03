import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { AgentBridge } from "../src/agent/bridge.ts";
import { buildApp } from "../src/app.ts";
import { QA_TEMPLATES_DIR } from "../src/paths.ts";
import { QaWorkspace } from "../src/reports/workspace.ts";

const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
let dir: string;
let app: FastifyInstance;
let bridge: AgentBridge;
let links: { executionReport: string; bugReport: string };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sfqa-rep-"));
  const qa = new QaWorkspace(join(dir, "qa"), QA_TEMPLATES_DIR);
  await qa.ensure();
  await writeFile(join(dir, "secret.txt"), "outside qa/");
  bridge = new AgentBridge();
  app = await buildApp({ token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: dir, runsDir: dir, qa, bridge, logger: false });
  await app.ready();
  links = (await app.inject({ url: "/reports/links", headers: auth })).json();
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const path = (url: string) => new URL(url).pathname;

test("report links need the agent token", async () => {
  assert.equal((await app.inject({ url: "/reports/links" })).statusCode, 401);
  assert.match(links.executionReport, /\/qa\/[0-9a-f]{32}\/reports\/Test_Execution_Report\.html$/);
});

test("report pages and data are served under the secret key, without a token", async () => {
  const page = await app.inject({ url: path(links.executionReport) });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] as string, /text\/html/);
  assert.match(page.body, /Salesforce QA · Test Execution Report/);
  const data = await app.inject({ url: path(links.executionReport).replace("Test_Execution_Report.html", "execution-data.js") });
  assert.match(data.body, /window\.TEST_EXECUTIONS/);
});

test("a wrong key, traversal, or unknown file type is refused", async () => {
  const good = path(links.bugReport);
  for (const url of [
    good.replace(/\/qa\/[0-9a-f]+\//, "/qa/0000000000000000000000000000000/"),
    good.replace("bugs/Bug_Report.html", "..%2F..%2Fsecret.txt"),
    good.replace("bugs/Bug_Report.html", "../secret.txt"),
    good.replace("Bug_Report.html", "bug-data.exe"),
  ]) {
    // A raw "../" is normalised away before routing (no route, so 401); everything else is a 404.
    const res = await app.inject({ url });
    assert.ok([401, 404].includes(res.statusCode), `${url} -> ${res.statusCode}`);
    assert.ok(!res.body.includes("outside qa/"), url);
  }
});

test("internal reports are routed by the bridge using the per-run key", async () => {
  const key = bridge.open("run-x", { step: async () => "Recorded step 1 (PASS).", bug: async () => "", finish: async () => "" });
  const body = { n: 1, action: "Open", status: "PASS", result: "ok" };
  const ok = await app.inject({ method: "POST", url: "/internal/runs/run-x/step", headers: { "x-sfqa-run-key": key }, payload: body });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().message, "Recorded step 1 (PASS).");
  const denied = await app.inject({ method: "POST", url: "/internal/runs/run-x/step", headers: { "x-sfqa-run-key": "nope" }, payload: body });
  assert.equal(denied.statusCode, 403);
  // A web page can't post reports: the Origin check still applies.
  const web = await app.inject({ method: "POST", url: "/internal/runs/run-x/step", headers: { "x-sfqa-run-key": key, origin: "https://evil.example" }, payload: body });
  assert.equal(web.statusCode, 403);
});
