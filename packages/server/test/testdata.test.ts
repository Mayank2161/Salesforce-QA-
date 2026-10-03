import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBridge } from "../src/agent/bridge.ts";
import { buildPrompt } from "../src/agent/prompt.ts";
import { QA_TEMPLATES_DIR } from "../src/paths.ts";
import { QaWorkspace } from "../src/reports/workspace.ts";
import { checkedFields, checkedSoql, compactRows, isAllowedSObject } from "../src/testdata/rules.ts";

test("only business objects may be created; users, permissions and setup may not", () => {
  for (const ok of ["Account", "Opportunity", "Contact", "Budget__c", "Opportunity_Line__c"]) assert.equal(isAllowedSObject(ok), true, ok);
  for (const no of ["User", "Profile", "PermissionSet", "PermissionSetAssignment", "Group", "UserRole", "Setting__mdt", "Alert__e", "Account__Share", "ApexClass"]) {
    assert.equal(isAllowedSObject(no), false, no);
  }
});

test("queries must be a single bounded SELECT", () => {
  assert.equal(checkedSoql("SELECT Id FROM Account WHERE Name = 'x'"), "SELECT Id FROM Account WHERE Name = 'x' LIMIT 50");
  assert.equal(checkedSoql("select Id from User limit 5"), "select Id from User limit 5");
  for (const bad of ["DELETE FROM Account", "SELECT Id FROM Account; SELECT Id FROM User", "SELECT Id FROM Account FOR UPDATE", "SELECT Id FROM Account LIMIT 5000"]) {
    assert.throws(() => checkedSoql(bad), Error, bad);
  }
});

test("fields must be valid API names with scalar values", () => {
  assert.deepEqual(checkedFields({ Name: "Shooting Store", Amount__c: 5000000, Active__c: true, Notes__c: null }), {
    Name: "Shooting Store", Amount__c: 5000000, Active__c: true, Notes__c: null,
  });
  assert.throws(() => checkedFields({}), /at least one field/);
  assert.throws(() => checkedFields({ "Name; DROP": "x" }), /not a valid field/);
  assert.throws(() => checkedFields({ Owner: { Id: "005" } }), /string, number, boolean or null/);
});

test("compactRows drops Salesforce attribute blocks, including nested ones", () => {
  const rows = [{ attributes: { type: "Account" }, Id: "001", Owner: { attributes: { type: "User" }, Name: "Zack" } }];
  assert.deepEqual(compactRows(rows), [{ Id: "001", Owner: { Name: "Zack" } }]);
});

let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "sfqa-td-")); });
after(() => rm(root, { recursive: true, force: true }));

test("test data is recorded per org and can be updated", async () => {
  const qa = new QaWorkspace(root, QA_TEMPLATES_DIR);
  await qa.ensure();
  assert.deepEqual(await qa.listTestData("tmcdev"), []);
  const rec = { sobject: "Account", id: "001bc00000AAAAAAAA", name: "Shooting Store", purpose: "UAT_021 precondition", fields: { Name: "Shooting Store" }, createdInRun: "RUN-20261001-020", testCase: "UAT_021", createdOn: "now" };
  await qa.addTestData("tmcdev", rec);
  await qa.updateTestData("tmcdev", rec.id, { OwnerId: "005zack" });
  const [saved] = await qa.listTestData("tmcdev");
  assert.deepEqual(saved?.fields, { Name: "Shooting Store", OwnerId: "005zack" });
  assert.deepEqual(await qa.listTestData("other-org"), []);
  await assert.rejects(qa.addTestData("../evil", rec), /Invalid org id/);
});

test("data tools are 404 when a run doesn't offer them", async () => {
  const bridge = new AgentBridge();
  const key = bridge.open("r", { step: async () => "", bug: async () => "", finish: async () => "" });
  const res = await bridge.dispatch("r", key, "create", { sobject: "Account", fields: { Name: "x" }, purpose: "p" });
  assert.equal(res.status, 404);
});

test("the prompt tells Claude to reuse, create missing data for the persona, and not fake the tested action", () => {
  const prompt = buildPrompt({
    org: { id: "o", name: "TMCDEV", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas: [] },
    persona: { id: "e", name: "Executive" },
    user: { id: "005bc00000ZACKAAA", name: "Zack Farber", username: "zack@rms.dev" },
    displayId: "RUN-20261001-020",
    testCase: { body: "UAT_021 ... Account = Shooting Store" },
    knownBugs: [],
    testData: [{ sobject: "Account", id: "001X", name: "Shooting Store", purpose: "UAT_021 precondition" }],
  });
  for (const s of [
    "User Id 005bc00000ZACKAAA",
    'Account "Shooting Store" (001X)',
    "Reuse first",
    "parents before children",
    "persona's User Id",
    "never to perform the action under test",
    "could not be created after trying",
  ]) {
    assert.ok(prompt.includes(s), s);
  }
});
