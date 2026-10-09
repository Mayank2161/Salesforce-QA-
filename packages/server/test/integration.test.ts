import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Persona, Run } from "@sfqa/shared";
import { performApiCall, type ApiCallContext } from "../src/agent/api-call.ts";
import { AgentBridge } from "../src/agent/bridge.ts";
import { describeToolUse } from "../src/agent/claude.ts";
import { buildPrompt } from "../src/agent/prompt.ts";
import { CallApi } from "../src/agent/protocol.ts";
import { buildApp } from "../src/app.ts";
import { loadExternalApis } from "../src/config/apis.ts";
import { executeRun, mcpServers } from "../src/runs/runner.ts";
import { RunStore } from "../src/runs/store.ts";
import { splitPersonas, toSuite } from "../src/suites/parse.ts";

// --- API checks -------------------------------------------------------------------------------

describe("call_api", () => {
  let server: Server;
  let base: string;
  let dir: string;
  const seen: { method: string; url: string; auth?: string; body: string }[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-api-"));
    server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        if (req.url!.endsWith("/redirect")) {
          res.writeHead(302, { Location: "https://elsewhere.example/steal" }).end();
          return;
        }
        res.writeHead(req.url!.includes("missing") ? 404 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url, echo: body ? JSON.parse(body) : null }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  let n = 0;
  const ctx = (over: Partial<ApiCallContext> = {}): ApiCallContext => ({
    salesforce: async (as) => ({ baseUrl: base, authorization: `Bearer sid-${as ?? "admin"}` }),
    externalApis: [
      { name: "erp", baseUrl: `${base}/api/v1`, headers: { Authorization: "Bearer ${ERP_TOKEN}" }, allowWrite: false },
      { name: "hub", baseUrl: `${base}/hub`, headers: {}, allowWrite: true },
    ],
    evidenceDir: dir,
    nextIndex: () => ++n,
    env: { ERP_TOKEN: "s3cret-token" },
    ...over,
  });
  const call = (input: object, c = ctx()) => performApiCall(c, CallApi.parse(input));

  test("calls a configured external API with secrets from .env, and saves evidence without them", async () => {
    const r = await call({ target: "erp", path: "/accounts?id=42", purpose: "Account synced to ERP" });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1)!.url, "/api/v1/accounts?id=42");
    assert.equal(seen.at(-1)!.auth, "Bearer s3cret-token");
    assert.match(r.file, /^api_\d{2}_get_account_synced_to_erp\.json$/);
    assert.match(r.message, /HTTP 200 OK .* Evidence saved as api_\d{2}_get_account_synced_to_erp\.json/);
    assert.match(r.message, /"path": "\/api\/v1\/accounts\?id=42"/);
    const saved = await readFile(join(dir, r.file), "utf8");
    assert.equal(JSON.parse(saved).response.body.ok, true);
    assert.doesNotMatch(saved + r.message, /s3cret/);
  });

  test("read-only external APIs refuse writes; writable ones accept a JSON body", async () => {
    await assert.rejects(call({ target: "erp", method: "POST", path: "/accounts", body: {}, purpose: "x" }), /erp is read-only/);
    const r = await call({ target: "hub", method: "POST", path: "/orders", body: { id: 7 }, purpose: "Push order" });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1)!.body, '{"id":7}');
  });

  test("non-2xx answers are data for the test, not errors; redirects are never followed", async () => {
    assert.equal((await call({ target: "erp", path: "/missing", purpose: "x" })).status, 404);
    const redirect = await call({ target: "hub", path: "/redirect", purpose: "Follow?" });
    assert.equal(redirect.status, 302);
    const saved = JSON.parse(await readFile(join(dir, redirect.file), "utf8"));
    assert.equal(saved.response.location, "https://elsewhere.example/steal");
    // Paths cannot climb out of the configured base URL.
    await assert.rejects(call({ target: "hub", path: "/../api/v1/accounts", purpose: "x" }), /contain no "\.\."/);
    await assert.rejects(call({ target: "salesforce", path: "/services/data/v62.0/../../x", purpose: "x" }), /contain no "\.\."/);
  });

  test("Salesforce: REST paths only, writes only to Apex REST, as the admin or a persona", async () => {
    const r = await call({ target: "salesforce", path: "/services/data/v62.0/sobjects/Account/001x", purpose: "Read account" });
    assert.equal(seen.at(-1)!.auth, "Bearer sid-admin");
    assert.equal(r.status, 200);
    await call({ target: "salesforce", path: "/services/data/v62.0/query?q=SELECT+Id+FROM+Account", as: "Sales", purpose: "Persona access" });
    assert.equal(seen.at(-1)!.auth, "Bearer sid-Sales");
    await assert.rejects(call({ target: "salesforce", path: "/secur/frontdoor.jsp", purpose: "x" }), /must use the REST API/);
    await assert.rejects(call({ target: "salesforce", method: "PATCH", path: "/services/data/v62.0/sobjects/Account/001x", body: {}, purpose: "x" }), /Only GET is allowed on \/services\/data\//);
    const apex = await call({ target: "salesforce", method: "POST", path: "/services/apexrest/erp/inbound", body: { acct: 1 }, purpose: "Inbound sync" });
    assert.equal(apex.status, 200);
    await assert.rejects(call({ target: "erp", as: "Sales", path: "/x", purpose: "x" }), /"as" applies only/);
  });

  test("unknown targets and missing secrets are explained", async () => {
    await assert.rejects(call({ target: "crm", path: "/x", purpose: "x" }), /Unknown API "crm"\. Available: salesforce, erp, hub/);
    await assert.rejects(call({ target: "erp", path: "/x", purpose: "x" }, ctx({ env: {} })), /needs ERP_TOKEN, which is not set in \.env/);
  });

  test("config/apis.json is optional, validated, and filtered by org", async () => {
    assert.deepEqual(await loadExternalApis(join(dir, "none.json")), []);
    const path = join(dir, "apis.json");
    await writeFile(path, JSON.stringify({ apis: [
      { name: "erp", baseUrl: "https://erp.example.com/api", orgs: ["tmcdev"] },
      { name: "hub", baseUrl: "https://hub.example.com" },
    ] }));
    assert.deepEqual((await loadExternalApis(path, "tmcdev")).map((a) => [a.name, a.allowWrite]), [["erp", false], ["hub", false]]);
    assert.deepEqual((await loadExternalApis(path, "other")).map((a) => a.name), ["hub"]);
    await writeFile(path, JSON.stringify({ apis: [{ name: "salesforce", baseUrl: "https://x.example.com" }] }));
    await assert.rejects(loadExternalApis(path), /reserved/);
  });
});

// --- Multi-persona tests ----------------------------------------------------------------------

const personas: Persona[] = [
  { id: "sales", name: "Sales", userFullName: "Jeff Kraft", profile: "Sales" },
  { id: "sales-manager", name: "Sales Manager", userFullName: "Kaylee Eastman", profile: "Sales" },
];
const org = { id: "tmcdev", name: "TMCDEV", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas };

describe("multi-persona tests", () => {
  test("the Persona cell can list several personas, first one first", () => {
    assert.deepEqual(splitPersonas("Sales User, Sales Manager"), ["Sales User", "Sales Manager"]);
    assert.deepEqual(splitPersonas("Sales -> Sales Manager → Finance; Admin + Ops & QA then Legal"), ["Sales", "Sales Manager", "Finance", "Admin", "Ops", "QA", "Legal"]);
    assert.deepEqual(splitPersonas("Sales and Marketing"), ["Sales and Marketing"]);

    const header = ["TC ID", "Title", "Persona", "Steps", "Expected Result"];
    const suite = toSuite("c.csv", [header,
      ["TC_1", "Approve discount", "Sales User, Sales Manager", "1. Submit\n2. Approve", "Approved"],
      ["TC_2", "x", "Sales, Finance", "1", "2"],
      ["TC_3", "x", "A, B, C, D, E", "1", "2"],
      ["TC_4", "x", "Sales, Sales", "1", "2"],
    ], personas);
    assert.deepEqual([suite.cases[0]!.personaId, suite.cases[0]!.extraPersonaIds], ["sales", ["sales-manager"]]);
    assert.match(suite.cases[1]!.error!, /Persona "Finance" does not match/);
    assert.match(suite.cases[2]!.error!, /at most 4 personas/);
    assert.equal(suite.cases[3]!.extraPersonaIds, undefined);
  });

  test("each persona gets its own browser tool server with its own session", () => {
    const servers = mcpServers({
      personas: [
        { persona: personas[0]!, user: { id: "005a", name: "Jeff Kraft", username: "j@x" }, stateFile: "/run/persona-state.json", server: "playwright" },
        { persona: personas[1]!, user: { id: "005b", name: "Kaylee Eastman", username: "k@x" }, stateFile: "/run/persona-state-2.json", server: "playwright_2" },
      ],
      runDir: "/run", browser: { channel: "chrome", headless: true }, playwrightMcpCli: "cli.js", qaMcpScript: "qa.ts", serverUrl: "http://127.0.0.1:1", runId: "r", key: "k",
    });
    assert.deepEqual(Object.keys(servers), ["playwright", "playwright_2", "qa"]);
    const arg = (s: string, flag: string) => servers[s]!.args[servers[s]!.args.indexOf(flag) + 1];
    assert.equal(arg("playwright", "--storage-state"), "/run/persona-state.json");
    assert.equal(arg("playwright_2", "--storage-state"), "/run/persona-state-2.json");
    assert.notEqual(arg("playwright", "--output-dir"), arg("playwright_2", "--output-dir"));
    assert.ok(servers.playwright!.args.includes("--headless"));
  });

  test("the prompt maps every persona to its browser tools and explains API checks", () => {
    const prompt = buildPrompt({
      org, persona: personas[0]!, user: { name: "Jeff Kraft", username: "j@x" }, displayId: "RUN-20261007-001", testCase: { body: "x" }, knownBugs: [],
      personas: [
        { persona: personas[0]!, user: { id: "005a", name: "Jeff Kraft", username: "j@x" }, server: "playwright" },
        { persona: personas[1]!, user: { id: "005b", name: "Kaylee Eastman", username: "k@x" }, server: "playwright_2" },
      ],
      apis: [{ name: "erp", description: "ERP test system", allowWrite: false }],
    });
    assert.match(prompt, /Sales Manager: Kaylee Eastman \(k@x\), profile Sales, User Id 005b\. Browser tools: mcp__playwright_2__browser_\*/);
    assert.match(prompt, /set "persona" to the persona who performed the step/);
    assert.match(prompt, /"erp": ERP test system \(read only\)/);
    assert.match(prompt, /record_step "apiEvidence"/);
    const single = buildPrompt({ org, persona: personas[0]!, user: { name: "J", username: "j@x" }, displayId: "RUN-20261007-001", testCase: { body: "x" }, knownBugs: [] });
    assert.doesNotMatch(single, /Personas and browsers/);
    assert.match(single, /\(none configured\)/);
  });

  test("the live log says which persona's browser acted", () => {
    assert.equal(describeToolUse("mcp__playwright_2__browser_click", { element: "Approve" }), "[persona 2] click: Approve");
    assert.equal(describeToolUse("mcp__playwright__browser_click", { element: "Submit" }), "click: Submit");
    assert.equal(describeToolUse("mcp__qa__call_api", { target: "erp" }), undefined);
  });

  test("a run stops at the first persona that cannot log in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sfqa-multi-"));
    await writeFile(join(dir, "orgs.json"), JSON.stringify({ orgs: [org] }));
    const store = new RunStore();
    const deps = { store, orgsConfigPath: join(dir, "orgs.json"), authDir: join(dir, "auth"), runsDir: join(dir, "runs"), browser: { channel: "chrome", headless: true } };
    const run = store.create({ orgId: "tmcdev", personaId: "sales", extraPersonaIds: ["sales-manager"], testCase: { body: "x" } });
    await executeRun(run.id, deps);
    const done = store.get(run.id)!;
    assert.equal(done.verdict, "BLOCKED");
    assert.deepEqual(done.steps.map((s) => [s.label, s.status]), [["0a", "BLOCKED"]]);
    assert.match(done.steps[0]!.actual!, /not connected yet/);

    const gone = store.create({ orgId: "tmcdev", personaId: "sales", extraPersonaIds: ["finance"], testCase: { body: "x" } });
    await executeRun(gone.id, deps);
    assert.match(store.get(gone.id)!.error!, /persona "finance" is no longer in config/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("multi-persona API", () => {
  const TOKEN = "test-token-0123456789";
  const auth = { authorization: `Bearer ${TOKEN}` };
  let dir: string;
  let app: FastifyInstance;
  const started: Run[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-multi-api-"));
    await writeFile(join(dir, "orgs.json"), JSON.stringify({ orgs: [org] }));
    app = await buildApp({ token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: dir, runsDir: dir, logger: false, bridge: new AgentBridge(), onRunCreated: (r) => started.push(r) });
    await app.ready();
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth, payload });

  test("POST /runs accepts other personas, and rejects unknown or repeated ones", async () => {
    const ok = await post("/runs", { orgId: "tmcdev", personaId: "sales", extraPersonaIds: ["sales-manager"], testCase: { body: "Submit, then approve" } });
    assert.equal(ok.statusCode, 202);
    assert.deepEqual(ok.json().request.extraPersonaIds, ["sales-manager"]);
    assert.equal((await post("/runs", { orgId: "tmcdev", personaId: "sales", extraPersonaIds: ["finance"], testCase: { body: "x" } })).statusCode, 404);
    assert.equal((await post("/runs", { orgId: "tmcdev", personaId: "sales", extraPersonaIds: ["sales"], testCase: { body: "x" } })).statusCode, 400);
  });

  test("a batch row with several personas becomes one multi-persona run", async () => {
    const res = await post("/suites", { orgId: "tmcdev", cases: [{ tcId: "TC_1", title: "Approve", personaId: "sales", extraPersonaIds: ["sales-manager", "sales"], body: "x" }] });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().items[0].personaName, "Sales + Sales Manager");
    assert.deepEqual(started.at(-1)!.request.extraPersonaIds, ["sales-manager"]);
    const bad = await post("/suites", { orgId: "tmcdev", cases: [{ tcId: "TC_2", title: "x", personaId: "sales", extraPersonaIds: ["finance"], body: "x" }] });
    assert.equal(bad.statusCode, 400);
  });
});
