import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Org } from "@sfqa/shared";
import { buildApp } from "../src/app.ts";
import { SalesforceApiError } from "../src/salesforce/api.ts";

const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let configPath: string;
let app: FastifyInstance;
const connects: string[] = [];
let finishConnect: () => void = () => {};
const searches: string[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sfqa-orgs-"));
  configPath = join(dir, "orgs.json");
  // Manually configured org with a custom id: detection must reuse it, not duplicate it.
  await writeFile(configPath, JSON.stringify({
    orgs: [{
      id: "rms-uat-custom",
      name: "My RMS UAT",
      loginUrl: "https://test.salesforce.com",
      instanceUrl: "https://rms--uat.sandbox.lightning.force.com",
      personas: [{ id: "admin", name: "Admin", username: "admin@rms.uat" }],
    }],
  }));
  app = await buildApp({
    token: TOKEN,
    orgsConfigPath: configPath,
    authDir: join(dir, "auth"),
    runsDir: join(dir, "runs"),
    connectOrg: (org: Org) => {
      connects.push(org.id);
      return new Promise<void>((resolve) => { finishConnect = resolve; });
    },
    searchUsers: async (org: Org, term: string) => {
      searches.push(`${org.id}:${term}`);
      if (org.id === "rms-uat-custom") throw new SalesforceApiError("not_connected", "not connected");
      return [{ id: "005bc00000UT0rRAAT", name: "Jeff Kraft", username: "jeffkraft@rms.com", profile: "RMS Sales" }];
    },
    logger: false,
  });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth, payload });
const savedConfig = async () => JSON.parse(await readFile(configPath, "utf8")) as { orgs: Org[] };
const jeff = { name: "Sales User", username: "jeffkraft@rms.com", userId: "005bc00000UT0rRAAT", userFullName: "Jeff Kraft", profile: "RMS Sales" };

describe("POST /orgs/detect", () => {
  test("registers a new sandbox from its hostname", async () => {
    const res = await post("/orgs/detect", { hostname: "rms--dev.sandbox.lightning.force.com" });
    assert.equal(res.statusCode, 200);
    const { org, created } = res.json();
    assert.equal(created, true);
    assert.equal(org.id, "rms-dev");
    assert.equal(org.name, "RMS - DEV");
    assert.equal(org.loginUrl, "https://rms--dev.sandbox.my.salesforce.com");
    assert.deepEqual(org.personas, []);
    assert.ok((await savedConfig()).orgs.some((o) => o.id === "rms-dev"), "written to orgs.json");
  });

  test("is idempotent and matches other domains of the same org", async () => {
    const res = await post("/orgs/detect", { hostname: "rms--dev.sandbox.my.salesforce.com" });
    assert.equal(res.json().created, false);
    assert.equal((await savedConfig()).orgs.filter((o) => o.id === "rms-dev").length, 1);
  });

  test("reuses a manually configured org with a different id", async () => {
    const res = await post("/orgs/detect", { hostname: "rms--uat.sandbox.lightning.force.com" });
    assert.equal(res.json().org.id, "rms-uat-custom");
    assert.equal(res.json().created, false);
  });

  test("rejects non-Salesforce hosts", async () => {
    for (const hostname of ["evil.com", "rms.lightning.force.com.evil.com"]) {
      assert.equal((await post("/orgs/detect", { hostname })).statusCode, 400, hostname);
    }
  });
});

describe("personas", () => {
  test("adds a persona linked to a Salesforce user", async () => {
    const res = await post("/orgs/rms-dev/personas", jeff);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().id, "sales-user");
    const persona = (await savedConfig()).orgs.find((o) => o.id === "rms-dev")?.personas[0];
    assert.equal(persona?.username, "jeffkraft@rms.com");
    assert.equal(persona?.userId, "005bc00000UT0rRAAT");
  });

  test("requires a username; rejects a malformed user id", async () => {
    assert.equal((await post("/orgs/rms-dev/personas", { name: "No User" })).statusCode, 400);
    assert.equal((await post("/orgs/rms-dev/personas", { ...jeff, name: "Bad", userId: "001xx0000000001" })).statusCode, 400);
  });

  test("duplicate persona is 409, unknown org is 404, blank name is 400", async () => {
    assert.equal((await post("/orgs/rms-dev/personas", { ...jeff, name: "sales user" })).statusCode, 409);
    assert.equal((await post("/orgs/nope/personas", jeff)).statusCode, 404);
    assert.equal((await post("/orgs/rms-dev/personas", { ...jeff, name: "  " })).statusCode, 400);
    assert.equal((await post("/orgs/rms-dev/personas", { ...jeff, name: "!!!" })).statusCode, 400);
  });

  test("concurrent adds are not lost", async () => {
    await Promise.all(["A1", "A2", "A3", "A4"].map((name) => post("/orgs/rms-dev/personas", { ...jeff, name })));
    const org = (await savedConfig()).orgs.find((o) => o.id === "rms-dev");
    for (const id of ["a1", "a2", "a3", "a4"]) assert.ok(org?.personas.some((p) => p.id === id), id);
  });

  test("DELETE removes a persona", async () => {
    const res = await app.inject({ method: "DELETE", url: "/orgs/rms-dev/personas/a4", headers: auth });
    assert.equal(res.statusCode, 204);
    assert.ok(!(await savedConfig()).orgs.find((o) => o.id === "rms-dev")?.personas.some((p) => p.id === "a4"));
    assert.equal((await app.inject({ method: "DELETE", url: "/orgs/rms-dev/personas/a4", headers: auth })).statusCode, 404);
  });
});

describe("GET /orgs/:orgId/users", () => {
  test("searches the org's users through the admin session", async () => {
    const res = await app.inject({ url: "/orgs/rms-dev/users?q=jeff", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().users[0].name, "Jeff Kraft");
    assert.ok(searches.includes("rms-dev:jeff"));
  });

  test("an org that is not connected is a 409, never a 401", async () => {
    const res = await app.inject({ url: "/orgs/rms-uat-custom/users?q=x", headers: auth });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "not_connected");
  });

  test("unknown org is 404", async () => {
    assert.equal((await app.inject({ url: "/orgs/nope/users", headers: auth })).statusCode, 404);
  });
});

describe("connect org", () => {
  test("starts a connect, reports it in progress, and refuses a second one", async () => {
    const res = await post("/orgs/rms-dev/connect", {});
    assert.equal(res.statusCode, 202);
    assert.deepEqual(connects, ["rms-dev"]);

    const during = (await app.inject({ url: "/connections", headers: auth })).json().connections;
    assert.equal(during.find((c: { orgId: string }) => c.orgId === "rms-dev").connectInProgress, true);
    assert.equal((await post("/orgs/rms-dev/connect", {})).statusCode, 409);

    finishConnect();
    await new Promise((r) => setTimeout(r, 10));
    const after = (await app.inject({ url: "/connections", headers: auth })).json().connections;
    assert.equal(after.find((c: { orgId: string }) => c.orgId === "rms-dev").connectInProgress, false);
  });

  test("unknown org is 404 and bad ids are 400", async () => {
    assert.equal((await post("/orgs/nope/connect", {})).statusCode, 404);
    assert.equal((await post("/orgs/RMS/connect", {})).statusCode, 400);
  });
});
