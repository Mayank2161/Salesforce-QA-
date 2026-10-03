import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SalesforceApi, SalesforceApiError, findUser, searchUsers, sidFromCookies, soqlString } from "../src/salesforce/api.ts";
import { myDomainUrl } from "../src/salesforce/session.ts";

// Fake Salesforce REST endpoint that records what it was asked.
let server: Server;
let base: string;
const seen: { auth?: string; q?: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    seen.push({ auth: req.headers.authorization, q: url.searchParams.get("q") ?? undefined });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization === "Bearer revoked-sid") {
      res.statusCode = 403;
      return res.end("Bad_OAuth_Token");
    }
    if (req.headers.authorization === "Bearer forbidden-sid") {
      res.statusCode = 403;
      return res.end(JSON.stringify([{ errorCode: "API_DISABLED_FOR_ORG" }]));
    }
    if (req.headers.authorization !== "Bearer good-sid") {
      res.statusCode = 401;
      return res.end(JSON.stringify([{ errorCode: "INVALID_SESSION_ID" }]));
    }
    if (req.method === "POST" && url.pathname.endsWith("/sobjects/Account")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ q: `POST ${body}` });
        if (!JSON.parse(body).Name) {
          res.statusCode = 400;
          return res.end(JSON.stringify([{ message: "Required fields are missing: [Name]", errorCode: "REQUIRED_FIELD_MISSING", fields: ["Name"] }]));
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ id: "001bc00000NEWAAA", success: true }));
      });
      return;
    }
    if (req.method === "PATCH") {
      seen.push({ q: `PATCH ${url.pathname}` });
      res.statusCode = 204;
      return res.end();
    }
    if (url.pathname === "/services/oauth2/userinfo") {
      return res.end(JSON.stringify({ user_id: "005000000000001AAA", name: "Mayank Jain", preferred_username: "mayank@tmc.dev", organization_id: "00D000000000001EAA" }));
    }
    res.end(JSON.stringify({
      records: [{ Id: "005bc00000UT0rRAAT", Name: "Jeff Kraft", Username: "jeffkraft@rms.com", IsActive: true, Profile: { Name: "RMS Sales" }, UserRole: null }],
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

test("sends the session id as a bearer token and maps rows", async () => {
  const users = await searchUsers(new SalesforceApi(base, "good-sid"), "jeff");
  assert.equal(seen.at(-1)?.auth, "Bearer good-sid");
  assert.deepEqual(users, [{ id: "005bc00000UT0rRAAT", name: "Jeff Kraft", username: "jeffkraft@rms.com", profile: "RMS Sales" }]);
});

test("search escapes quotes and LIKE wildcards", async () => {
  await searchUsers(new SalesforceApi(base, "good-sid"), "o'brien 100%_");
  const q = seen.at(-1)?.q ?? "";
  assert.match(q, /LIKE '%o\\'brien 100\\%\\_%'/);
  assert.match(q, /IsActive = true AND UserType = 'Standard'/);
});

test("findUser queries by id or username", async () => {
  const api = new SalesforceApi(base, "good-sid");
  assert.equal((await findUser(api, { username: "jeffkraft@rms.com" }))?.active, true);
  assert.match(seen.at(-1)?.q ?? "", /Username = 'jeffkraft@rms.com'/);
  await findUser(api, { userId: "005bc00000UT0rRAAT" });
  assert.match(seen.at(-1)?.q ?? "", /Id = '005bc00000UT0rRAAT'/);
});

test("whoAmI returns the session's user and org", async () => {
  const me = await new SalesforceApi(base, "good-sid").whoAmI();
  assert.equal(me.name, "Mayank Jain");
  assert.equal(me.orgId, "00D000000000001EAA");
});

test("an expired session is reported as session_expired (401, or 403 Bad_OAuth_Token)", async () => {
  for (const sid of ["old-sid", "revoked-sid"]) {
    await assert.rejects(new SalesforceApi(base, sid).whoAmI(), (err: unknown) => {
      return err instanceof SalesforceApiError && err.code === "session_expired";
    }, sid);
  }
});

test("other 403s are not mistaken for an expired session", async () => {
  await assert.rejects(new SalesforceApi(base, "forbidden-sid").whoAmI(), (err: unknown) => {
    return err instanceof SalesforceApiError && err.code === "request_failed";
  });
});

test("create and update records, with readable Salesforce errors", async () => {
  const api = new SalesforceApi(base, "good-sid");
  assert.equal(await api.create("Account", { Name: "Shooting Store" }), "001bc00000NEWAAA");
  assert.match(seen.at(-1)?.q ?? "", /POST \{"Name":"Shooting Store"\}/);
  await assert.rejects(api.create("Account", { Phone: "1" }), /REQUIRED_FIELD_MISSING: Required fields are missing: \[Name\] \(fields: Name\)/);
  await api.update("Account", "001bc00000NEWAAA", { OwnerId: "005x" });
  assert.match(seen.at(-1)?.q ?? "", /PATCH .*\/sobjects\/Account\/001bc00000NEWAAA$/);
});

test("sidFromCookies picks the My Domain sid, not the Lightning one", () => {
  const cookies = [
    { name: "sid", value: "lightning-sid", domain: "acme--uat.sandbox.lightning.force.com" },
    { name: "sid", value: "mydomain-sid", domain: "acme--uat.sandbox.my.salesforce.com" },
  ];
  assert.equal(sidFromCookies(cookies, "https://acme--uat.sandbox.my.salesforce.com"), "mydomain-sid");
  assert.equal(sidFromCookies(cookies, "https://other.my.salesforce.com"), undefined);
});

test("myDomainUrl derives the My Domain host from the Lightning URL", () => {
  const org = { id: "x", name: "x", loginUrl: "https://test.salesforce.com", instanceUrl: "https://acme--uat.sandbox.lightning.force.com", personas: [] };
  assert.equal(myDomainUrl(org), "https://acme--uat.sandbox.my.salesforce.com");
});

test("soqlString escapes backslashes and quotes", () => {
  assert.equal(soqlString(String.raw`a\b'c`), String.raw`a\\b\'c`);
});
