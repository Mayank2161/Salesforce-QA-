import { test } from "node:test";
import assert from "node:assert/strict";
import { SlugId, detectOrgFromHostname, myDomainOf } from "../src/index.ts";

const cases: [string, { id: string; name: string; kind: string; loginUrl: string; instanceUrl: string }][] = [
  ["rms--dev.sandbox.lightning.force.com", {
    id: "rms-dev", name: "RMS - DEV", kind: "sandbox",
    loginUrl: "https://rms--dev.sandbox.my.salesforce.com", instanceUrl: "https://rms--dev.sandbox.lightning.force.com",
  }],
  ["rms--uat.sandbox.my.salesforce.com", {
    id: "rms-uat", name: "RMS - UAT", kind: "sandbox",
    loginUrl: "https://rms--uat.sandbox.my.salesforce.com", instanceUrl: "https://rms--uat.sandbox.lightning.force.com",
  }],
  ["rms--qa.sandbox.my.salesforce-setup.com", {
    id: "rms-qa", name: "RMS - QA", kind: "sandbox",
    loginUrl: "https://rms--qa.sandbox.my.salesforce.com", instanceUrl: "https://rms--qa.sandbox.lightning.force.com",
  }],
  ["RMS.lightning.force.com", {
    id: "rms-production", name: "RMS - PRODUCTION", kind: "production",
    loginUrl: "https://rms.my.salesforce.com", instanceUrl: "https://rms.lightning.force.com",
  }],
  ["acme-dev-ed.develop.lightning.force.com", {
    id: "acme-dev-ed", name: "ACME - DEV ED", kind: "developer",
    loginUrl: "https://acme-dev-ed.develop.my.salesforce.com", instanceUrl: "https://acme-dev-ed.develop.lightning.force.com",
  }],
  // Legacy (non-enhanced) sandbox domain without ".sandbox".
  ["globex--staging.my.salesforce.com", {
    id: "globex-staging", name: "GLOBEX - STAGING", kind: "sandbox",
    loginUrl: "https://globex--staging.my.salesforce.com", instanceUrl: "https://globex--staging.lightning.force.com",
  }],
];

for (const [hostname, expected] of cases) {
  test(`detects ${hostname}`, () => {
    const org = detectOrgFromHostname(hostname);
    assert.ok(org);
    assert.deepEqual(
      { id: org.id, name: org.name, kind: org.kind, loginUrl: org.loginUrl, instanceUrl: org.instanceUrl },
      expected,
    );
    assert.equal(SlugId.safeParse(org.id).success, true, "id must be a valid slug");
  });
}

test("non-Salesforce and lookalike hosts are not detected", () => {
  for (const host of ["google.com", "login.salesforce.com", "evil.com", "rms.lightning.force.com.evil.com", "a.b.lightning.force.com"]) {
    assert.equal(detectOrgFromHostname(host), undefined, host);
  }
});

test("myDomainOf matches all of an org's domains", () => {
  assert.equal(myDomainOf("https://rms--dev.sandbox.lightning.force.com"), "rms--dev");
  assert.equal(myDomainOf("https://rms--dev.sandbox.my.salesforce.com/x"), "rms--dev");
});
