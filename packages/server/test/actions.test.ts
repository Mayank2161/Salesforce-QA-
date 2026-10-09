import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { RunStepsInput, formatBatch, runSteps, type RunStepsInput as Input } from "../src/agent/actions.ts";
import { launchBrowser, browserSettingsFromEnv } from "../src/salesforce/browser.ts";

// A small stand-in for a Lightning record page: view mode, an edit modal with a picklist and a
// required field, a spinner while saving, a success toast, and a validation error.
const PAGE = `<!doctype html><html><head><title>ABC | Account</title><style>.hidden{display:none}</style></head><body>
<div class="slds-form-element"><span class="slds-form-element__label">Channel Type</span>
  <div class="slds-form-element__control"><span class="slds-form-element__static" id="v-channel">Wholesale</span></div></div>
<div class="slds-form-element"><span class="slds-form-element__label">Account Name</span>
  <div class="slds-form-element__control"><span class="slds-form-element__static" id="v-name">ABC</span></div></div>
<button id="edit">Edit</button><button>Delete</button><button>Delete</button>
<button class="hidden">Save</button>
<section role="dialog" aria-label="Edit ABC" id="modal" class="hidden"><h2>Edit ABC</h2>
  <div class="slds-form-element" id="name-box"><label for="name"><abbr>*</abbr>Account Name</label>
    <input id="name" value="ABC"><div class="slds-form-element__help" id="name-err"></div></div>
  <div class="slds-form-element"><label class="slds-form-element__label" id="ct-label">Channel Type</label>
    <button role="combobox" aria-labelledby="ct-label" id="ct">Wholesale</button>
    <div role="listbox" id="ct-list" class="hidden">
      <div role="option">--None--</div><div role="option">Wholesale</div><div role="option">Retail</div><div role="option">Online</div>
    </div></div>
  <button id="save">Save</button><button id="cancel">Cancel</button>
</section>
<div id="spinner" class="slds-spinner_container hidden">loading</div>
<div id="toasts"></div>
<script>(() => {
  const $ = (id) => document.getElementById(id);
  $("edit").onclick = () => { $("modal").classList.remove("hidden"); };
  $("cancel").onclick = () => { $("modal").classList.add("hidden"); };
  $("ct").onclick = () => $("ct-list").classList.toggle("hidden");
  for (const o of document.querySelectorAll("[role=option]")) o.onclick = () => { $("ct").textContent = o.textContent; $("ct-list").classList.add("hidden"); };
  $("save").onclick = () => {
    $("spinner").classList.remove("hidden");
    setTimeout(() => {
      $("spinner").classList.add("hidden");
      if (!$("name").value) {
        $("name-box").classList.add("slds-has-error");
        $("name-err").textContent = "Complete this field.";
        return;
      }
      $("v-channel").textContent = $("ct").textContent;
      $("v-name").textContent = $("name").value;
      $("modal").classList.add("hidden");
      $("toasts").innerHTML = '<div class="forceToastMessage">Account "' + $("name").value + '" was saved.</div>';
    }, 400);
  };
})();</script></body></html>`;

let browser: Browser;
let page: Page;
let dir: string;

before(async () => {
  browser = await launchBrowser({ ...browserSettingsFromEnv(), headless: true });
  page = await browser.newPage();
  dir = mkdtempSync(join(tmpdir(), "sfqa-actions-"));
});
after(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = async (input: unknown) => {
  await page.setContent(PAGE);
  return runSteps(page, RunStepsInput.parse(input) as Input, dir);
};

test("a planned edit runs as one batch: edit, select, fill, save, toast, verify, screenshot", async () => {
  const r = await run({
    steps: [
      { action: "click", target: { role: "button", name: "Edit" } },
      { action: "select", field: "Channel Type", value: "Retail" },
      { action: "fill", field: "Account Name", value: "ABC Retail" },
      { action: "click", target: { role: "button", name: "Save" } },
      { action: "waitForToast" },
      { action: "verifyField", field: "Channel Type", expected: "Retail" },
      { action: "getField", field: "Account Name" },
      { action: "screenshot", filename: "04_saved.png" },
    ],
  });
  assert.deepEqual(r.outcomes.map((o) => o.status), Array(8).fill("ok"), formatBatch(r));
  assert.match(r.outcomes[4]!.detail, /Account "ABC Retail" was saved/);
  assert.match(r.outcomes[6]!.detail, /"ABC Retail"/);
  assert.ok(existsSync(join(dir, "04_saved.png")));
  assert.equal(r.stoppedAt, undefined);
});

test("a missing picklist value stops the batch, lists the options shown, and skips the rest", async () => {
  const r = await run({
    steps: [
      { action: "click", target: { role: "button", name: "Edit" } },
      { action: "select", field: "Channel Type", value: "Distributor" },
      { action: "click", target: { role: "button", name: "Save" } },
    ],
  });
  assert.deepEqual(r.outcomes.map((o) => o.status), ["ok", "error", "skipped"], formatBatch(r));
  assert.match(r.outcomes[1]!.detail, /--None-- \| Wholesale \| Retail \| Online/);
  assert.equal(r.stoppedAt, 2);
  assert.match(formatBatch(r), /Take over with the normal browser tools/);
});

test("a failed save is reported as the error the page shows, never as success", async () => {
  const r = await run({
    steps: [
      { action: "click", target: { role: "button", name: "Edit" } },
      { action: "clear", field: "Account Name" },
      { action: "click", target: { role: "button", name: "Save" } },
      { action: "waitForToast" },
      { action: "verifyField", field: "Account Name", expected: "" },
    ],
  });
  assert.deepEqual(r.outcomes.map((o) => o.status), ["ok", "ok", "ok", "mismatch", "skipped"]);
  assert.match(r.outcomes[3]!.detail, /Complete this field\./);
  assert.ok(r.state.errors.some((e) => /Complete this field/.test(e)));
  assert.deepEqual(r.state.dialogs, ["Edit ABC"]);
});

test("verify steps report mismatches; stopOnMismatch=false keeps going", async () => {
  const r = await run({
    steps: [
      { action: "verifyField", field: "Channel Type", expected: "Retail" },
      { action: "verifyText", text: "Wholesale" },
      { action: "verifyVisible", target: { role: "button", name: "Edit" }, visible: false },
    ],
    stopOnMismatch: false,
  });
  assert.deepEqual(r.outcomes.map((o) => o.status), ["mismatch", "ok", "mismatch"]);
  assert.match(r.outcomes[0]!.detail, /"Channel Type" = "Wholesale"; expected equals "Retail"/);
});

test("ambiguous and missing targets are errors, never a guess", async () => {
  const ambiguous = await run({ steps: [{ action: "click", target: { role: "button", name: "Delete" } }] });
  assert.equal(ambiguous.outcomes[0]!.status, "error");
  assert.match(ambiguous.outcomes[0]!.detail, /ambiguous: 2 visible matches/);

  const missing = await run({ steps: [{ action: "click", target: { role: "button", name: "Clone" }, timeout: 800 }] });
  assert.equal(missing.outcomes[0]!.status, "error");
  assert.match(missing.outcomes[0]!.detail, /not found/);

  // A hidden duplicate (the page-level Save) is ignored: only visible elements count.
  const picked = await run({ steps: [{ action: "click", target: { role: "button", name: "Delete", index: 1 } }] });
  assert.equal(picked.outcomes[0]!.status, "ok");
});

test("listOptions opens a picklist and returns every option", async () => {
  const r = await run({
    steps: [
      { action: "click", target: { role: "button", name: "Edit" } },
      { action: "listOptions", field: "Channel Type" },
    ],
  });
  assert.equal(r.outcomes[1]!.status, "ok");
  assert.match(r.outcomes[1]!.detail, /options \(4\): --None-- \| Wholesale \| Retail \| Online/);
});

test("waits are condition-based: waitFor hidden returns as soon as the element is gone", async () => {
  await page.setContent(PAGE);
  const start = Date.now();
  const r = await runSteps(page, RunStepsInput.parse({ steps: [{ action: "waitFor", target: { role: "button", name: "Clone" }, state: "hidden" }] }) as Input, dir);
  assert.equal(r.outcomes[0]!.status, "ok");
  assert.ok(Date.now() - start < 2000);
});

test("run_steps input is validated (unsafe screenshot names and empty targets are rejected)", () => {
  assert.equal(RunStepsInput.safeParse({ steps: [{ action: "screenshot", filename: "../x.png" }] }).success, false);
  assert.equal(RunStepsInput.safeParse({ steps: [{ action: "click", target: {} }] }).success, false);
  assert.equal(RunStepsInput.safeParse({ steps: [] }).success, false);
});

// --- Regressions found on a real org (run-steps.log) ---

test("org-relative URLs work on a fresh browser (about:blank) when the org origin is known", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => res.setHeader("Content-Type", "text/html").end("<title>Home</title><h1>Lightning Home</h1>")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const blank = await browser.newPage();
    const input = RunStepsInput.parse({ steps: [{ action: "navigate", url: "/lightning/page/home" }, { action: "verifyText", text: "Lightning Home" }] }) as Input;
    const r = await runSteps(blank, input, dir, { baseUrl: origin });
    assert.deepEqual(r.outcomes.map((o) => o.status), ["ok", "ok"], formatBatch(r));
    assert.equal(r.state.url, `${origin}/lightning/page/home`);

    const without = await runSteps(await browser.newPage(), input, dir);
    assert.equal(without.outcomes[0]!.status, "error");
    assert.match(without.outcomes[0]!.detail, /relative.*Use the full URL/);
  } finally {
    server.close();
  }
});

test("a 'leave page?' dialog stops the batch at once instead of hanging the navigation", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => res.setHeader("Content-Type", "text/html").end("<input aria-label='Name'><script>onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; };</script>")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const p = await browser.newPage();
  // Playwright MCP keeps a dialog listener, so dialogs wait for an answer; mimic it.
  p.on("dialog", () => undefined);
  try {
    await p.goto(origin);
    const start = Date.now();
    const r = await runSteps(p, RunStepsInput.parse({ steps: [
      { action: "fill", target: { label: "Name" }, value: "unsaved" },
      { action: "navigate", url: "/other" },
      { action: "screenshot", filename: "never.png" },
    ] }) as Input, dir);
    assert.ok(Date.now() - start < 15_000, `took ${Date.now() - start} ms`);
    assert.deepEqual(r.outcomes.map((o) => o.status), ["ok", "error", "skipped"], formatBatch(r));
    assert.match(r.outcomes[1]!.detail, /browser dialog opened \(beforeunload/);
    assert.match(formatBatch(r), /browser_handle_dialog/);
  } finally {
    await p.close({ runBeforeUnload: false });
    server.close();
  }
});

test("a non-modal error popover does not hide the inline-edit fields behind it", async () => {
  await page.setContent(`<div class="slds-form-element"><label for="n">*Account Name</label><input id="n" value=""></div>
    <section role="dialog" aria-label="We hit a snag."><h2>We hit a snag.</h2><p>Review the following fields</p><a href="#n">Account Name</a></section>
    <button>Save</button>`);
  const r = await runSteps(page, RunStepsInput.parse({ steps: [
    { action: "fill", field: "Account Name", value: "Shooting Store" },
    { action: "click", target: { role: "button", name: "Save" } },
  ] }) as Input, dir);
  assert.deepEqual(r.outcomes.map((o) => o.status), ["ok", "ok"], formatBatch(r));
  assert.equal(await page.locator("#n").inputValue(), "Shooting Store");
});

test("a dialog left open before the batch is detected in seconds instead of hanging run_steps", async () => {
  const p = await browser.newPage();
  p.on("dialog", () => undefined); // like Playwright MCP: the dialog waits for browser_handle_dialog
  try {
    await p.setContent("<button>Save</button>");
    const shown = p.waitForEvent("dialog");
    void p.evaluate(() => setTimeout(() => alert("Unsaved changes"), 0)).catch(() => undefined);
    await shown;
    const start = Date.now();
    const r = await runSteps(p, RunStepsInput.parse({ steps: [{ action: "click", target: { role: "button", name: "Save" } }, { action: "screenshot", filename: "x.png" }] }) as Input, dir);
    assert.ok(Date.now() - start < 6_000, `took ${Date.now() - start} ms`);
    assert.deepEqual(r.outcomes.map((o) => o.status), ["error", "skipped"]);
    assert.match(formatBatch(r), /not responding[\s\S]*browser_handle_dialog/);
  } finally {
    await p.close();
  }
});

test("every step has a hard time limit, so run_steps always returns to Claude", async () => {
  await page.setContent("<p>loading</p>");
  const r = await runSteps(page, RunStepsInput.parse({ steps: [{ action: "waitForText", text: "never", timeout: 5000 }, { action: "reload" }] }) as Input, dir, {}, { stepMs: 400 });
  assert.deepEqual(r.outcomes.map((o) => o.status), ["error", "skipped"]);
  assert.match(r.outcomes[0]!.detail, /Did not finish within/);
});
