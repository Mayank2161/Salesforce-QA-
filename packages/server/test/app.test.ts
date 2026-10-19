import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { RunEvent } from "@sfqa/shared";
import { buildApp } from "../src/app.ts";
import { RunStore } from "../src/runs/store.ts";

const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const orgsConfig = {
  orgs: [{
    id: "uat",
    name: "UAT",
    loginUrl: "https://test.salesforce.com",
    instanceUrl: "https://acme--uat.sandbox.lightning.force.com",
    personas: [{ id: "rep", name: "Sales Rep" }],
  }],
};
const validRun = { orgId: "uat", personaId: "rep", testCase: { body: "Create a lead" } };
// injectWS sends no Host header by default; real browsers always do.
const wsContext = { headers: { host: "127.0.0.1:4317" } };

let dir: string;
let app: FastifyInstance;
let store: RunStore;
const created: string[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sfqa-"));
  await writeFile(join(dir, "orgs.json"), JSON.stringify(orgsConfig));
  await mkdir(join(dir, "auth", "uat"), { recursive: true });
  await writeFile(join(dir, "auth", "uat", "admin.json"), "{}");
  store = new RunStore();
  app = await buildApp({
    token: TOKEN,
    orgsConfigPath: join(dir, "orgs.json"),
    authDir: join(dir, "auth"),
    runsDir: join(dir, "runs"),
    store,
    onRunCreated: (run) => created.push(run.id),
    logger: false,
  });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("security", () => {
  test("/health is public", async () => {
    const res = await app.inject({ url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  test("missing or wrong token is 401", async () => {
    assert.equal((await app.inject({ url: "/orgs" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/orgs", headers: { authorization: "Bearer nope" } })).statusCode, 401);
  });

  test("query-string token is not accepted for plain HTTP", async () => {
    assert.equal((await app.inject({ url: `/orgs?token=${TOKEN}` })).statusCode, 401);
  });

  test("web origins are rejected, extension origin is allowed", async () => {
    const evil = await app.inject({ url: "/orgs", headers: { ...auth, origin: "https://evil.example" } });
    assert.equal(evil.statusCode, 403);
    const ext = await app.inject({ url: "/orgs", headers: { ...auth, origin: "chrome-extension://abcdef" } });
    assert.equal(ext.statusCode, 200);
  });

  test("non-loopback Host header is rejected (DNS rebinding)", async () => {
    const res = await app.inject({ url: "/health", headers: { host: "evil.example:4317" } });
    assert.equal(res.statusCode, 403);
  });
});

describe("orgs", () => {
  test("GET /orgs returns the config", async () => {
    const res = await app.inject({ url: "/orgs", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().orgs[0].id, "uat");
  });

  test("missing config file means no orgs yet", async () => {
    const fresh = await buildApp({
      token: TOKEN, orgsConfigPath: join(dir, "missing.json"), authDir: dir, runsDir: dir, logger: false,
    });
    const res = await fresh.inject({ url: "/orgs", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { orgs: [] });
    await fresh.close();
  });

  test("corrupt config file is a config_error", async () => {
    await writeFile(join(dir, "corrupt.json"), "{ not json");
    const broken = await buildApp({
      token: TOKEN, orgsConfigPath: join(dir, "corrupt.json"), authDir: dir, runsDir: dir, logger: false,
    });
    const res = await broken.inject({ url: "/orgs", headers: auth });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "config_error");
    await broken.close();
  });
});

describe("runs", () => {
  test("invalid body is 400", async () => {
    const res = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: { orgId: "uat" } });
    assert.equal(res.statusCode, 400);
  });

  test("unknown org and persona are 404", async () => {
    const org = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: { ...validRun, orgId: "prod" } });
    assert.equal(org.json().error, "unknown_org");
    const persona = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: { ...validRun, personaId: "ceo" } });
    assert.equal(persona.json().error, "unknown_persona");
  });

  test("valid run is queued and retrievable", async () => {
    const res = await app.inject({ method: "POST", url: "/runs", headers: auth, payload: validRun });
    assert.equal(res.statusCode, 202);
    const run = res.json();
    assert.equal(run.status, "queued");
    assert.ok(created.includes(run.id), "onRunCreated should be called");

    const got = await app.inject({ url: `/runs/${run.id}`, headers: auth });
    assert.equal(got.json().id, run.id);
    const list = await app.inject({ url: "/runs", headers: auth });
    assert.ok(list.json().runs.some((r: { id: string }) => r.id === run.id));
  });

  test("unknown run is 404", async () => {
    const res = await app.inject({ url: "/runs/does-not-exist", headers: auth });
    assert.equal(res.statusCode, 404);
  });
});

describe("connections", () => {
  test("GET /connections reports the saved admin session per org", async () => {
    const res = await app.inject({ url: "/connections", headers: auth });
    assert.equal(res.statusCode, 200);
    const [c] = res.json().connections;
    assert.equal(c.orgId, "uat");
    assert.equal(c.connected, true);
    assert.ok(c.savedAt);
    assert.equal(c.connectInProgress, false);
    assert.equal(c.expired, undefined, "not verified unless asked");
  });

  test("GET /connections?verify=1 reports an expired admin session", async () => {
    const verifying = await buildApp({
      token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: join(dir, "auth"), runsDir: dir, logger: false,
      verifyConnection: async () => false,
    });
    const [c] = (await verifying.inject({ url: "/connections?verify=1", headers: auth })).json().connections;
    assert.equal(c.expired, true);
    await verifying.close();
  });
});

describe("evidence", () => {
  const runId = "3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f";

  before(async () => {
    await mkdir(join(dir, "runs", runId), { recursive: true });
    await writeFile(join(dir, "runs", runId, "step-0.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("serves a screenshot with the right content type", async () => {
    const res = await app.inject({ url: `/runs/${runId}/evidence/step-0.png`, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/png");
  });

  test("rejects traversal and unexpected names", async () => {
    for (const url of [
      `/runs/${runId}/evidence/..%2F..%2Forgs.json`,
      `/runs/${runId}/evidence/secret.txt`,
      `/runs/not-a-uuid/evidence/step-0.png`,
    ]) {
      const res = await app.inject({ url, headers: auth });
      assert.equal(res.statusCode, 400, url);
    }
  });

  test("missing evidence is 404 and needs a token", async () => {
    assert.equal((await app.inject({ url: `/runs/${runId}/evidence/step-9.png`, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ url: `/runs/${runId}/evidence/step-0.png` })).statusCode, 401);
  });
});

describe("events WebSocket", () => {
  test("streams snapshot, live events, and completion", async () => {
    const run = store.create(validRun);
    const events: RunEvent[] = [];
    let closed!: Promise<void>;
    let firstMessage!: Promise<void>;
    // Attach listeners in onInit: the server's snapshot can arrive before injectWS resolves.
    await app.injectWS(`/runs/${run.id}/events?token=${TOKEN}`, wsContext, {
      onInit: (ws) => {
        closed = new Promise((resolve) => ws.on("close", () => resolve()));
        firstMessage = new Promise((resolve) => ws.once("message", () => resolve()));
        ws.on("message", (data) => events.push(JSON.parse(data.toString())));
      },
    });

    await firstMessage;
    store.markRunning(run.id);
    store.addStep(run.id, { index: 0, description: "Open Leads", status: "PASS", screenshots: [], startedAt: run.createdAt, finishedAt: run.createdAt });
    store.finish(run.id);
    await closed;

    assert.deepEqual(events.map((e) => e.type), ["run.status", "run.status", "run.step", "run.status", "run.completed"]);
    const last = events.at(-1);
    assert.equal(last?.type === "run.completed" && last.run.verdict, "PASS");
  });

  test("sends a heartbeat while the run is quiet, so the extension's connection stays up", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const run = store.create(validRun);
    const events: RunEvent[] = [];
    let firstMessage!: Promise<void>;
    let closed!: Promise<void>;
    await app.injectWS(`/runs/${run.id}/events?token=${TOKEN}`, wsContext, {
      onInit: (ws) => {
        closed = new Promise((resolve) => ws.on("close", () => resolve()));
        firstMessage = new Promise((resolve) => ws.once("message", () => resolve()));
        ws.on("message", (data) => events.push(JSON.parse(data.toString())));
      },
    });
    await firstMessage;
    t.mock.timers.tick(20_000);
    t.mock.timers.tick(20_000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events.map((e) => e.type), ["run.status", "run.heartbeat", "run.heartbeat"]);
    store.finish(run.id);
    await closed;
  });

  test("rejects handshake without token", async () => {
    const run = store.create(validRun);
    await assert.rejects(app.injectWS(`/runs/${run.id}/events`, wsContext), /401/);
  });
});
