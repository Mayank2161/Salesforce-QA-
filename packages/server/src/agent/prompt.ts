import type { Org, Persona, TestCase } from "@sfqa/shared";

export interface PromptContext {
  org: Org;
  persona: Persona;
  user: { id?: string; name: string; username: string };
  displayId: string;
  testCase: TestCase;
  knownBugs: { id: string; title: string; status: string }[];
  // Records created for testing by earlier runs in this org.
  testData?: { sobject: string; id: string; name: string; purpose: string }[];
  // Multi-persona runs: every persona with its own browser (MCP server name). The first is ctx.persona.
  personas?: { persona: Persona; user: { id?: string; name: string; username: string }; server: string }[];
  // External systems call_api may reach (besides "salesforce").
  apis?: { name: string; description?: string; allowWrite: boolean }[];
  // Hybrid execution: the browser also offers run_steps (generic actions performed as one batch).
  hybrid?: boolean;
}

// How to use run_steps without lowering the bar: Claude still plans each step and judges each result.
function hybridSection(ctx: PromptContext): string {
  if (!ctx.hybrid) return "";
  const tool = ctx.personas && ctx.personas.length > 1 ? "run_steps; each persona's browser has its own, e.g. mcp__playwright_2__run_steps" : "run_steps";
  return `
## Fast execution (${tool})
You decide every action and judge every result, exactly as before. run_steps only performs actions you have already decided on, several per call, instead of one browser tool call each. It addresses elements by visible label, role or text (or a ref from browser_snapshot), waits for Salesforce to finish loading after each action, and returns a short result per action plus the toasts, errors and dialogs now on the page.
- Use it when you know exactly what to do next and no step depends on what an earlier one shows. Example, "Open Account ABC and set Channel Type to Retail": navigate to the record (Id from query_records) -> click button "Edit" -> select "Channel Type" = "Retail" -> click button "Save" -> waitForToast -> verifyField "Channel Type" = "Retail" -> screenshot "04_channel_type_saved.png".
- Use the single browser_* tools (browser_snapshot first) when the page is unknown or may vary: a layout you have not seen, finding which buttons or fields exist, conditional fields, unexpected popups or errors, complex negative scenarios. Exploring is part of testing; never guess a label to save a call.
- End a batch where you must look before continuing: a result to validate before the next step, a choice that depends on what appears, or a save whose outcome decides what happens next (end with waitForToast and read the result).
- When run_steps stops at a step it could not perform (element not found, ambiguous, unexpected dialog), take over from that step with browser_snapshot and the normal browser tools. That alone is never a test failure: judge the application, not the tool.
- Picklist checks: listOptions returns every option of a picklist, and select lists the options shown when a value is missing. Quote them in "result".
- Its verify actions (verifyField, verifyText, verifyVisible) and the toasts it reports are evidence you may quote, but you decide PASS/FAIL. When a check depends on what a user sees (layout, which fields are shown or editable, highlighting), look with browser_snapshot or browser_take_screenshot.
- Evidence rules are unchanged: every step needs its own screenshot. A run_steps "screenshot" action saves the file without sending it to you, and record_step accepts it. Take it once the step's result is on screen.
- Prefer condition waits (waitForText, waitForToast, waitFor) over browser_wait_for with a fixed time.
`;
}

function personasSection(ctx: PromptContext): string {
  if (!ctx.personas || ctx.personas.length < 2) return "";
  const rows = ctx.personas.map((p) =>
    `- ${p.persona.name}: ${p.user.name} (${p.user.username})${p.persona.profile ? `, profile ${p.persona.profile}` : ""}${p.user.id ? `, User Id ${p.user.id}` : ""}. Browser tools: mcp__${p.server}__browser_* (for example mcp__${p.server}__browser_click).`).join("\n");
  return `
## Personas and browsers
This test involves ${ctx.personas.length} personas. Each has its OWN browser, already logged in as that persona through Login As:
${rows}
- Perform every step with the browser of the persona the step is for. For example, the Sales user submits in their browser, then the manager approves in the manager's browser. Never try to switch user inside a browser.
- After one persona changes something, reload the other persona's page before checking it.
- In record_step, set "persona" to the persona who performed the step. Screenshots from any browser go in the same folder; keep the NN_ numbering in one sequence across all browsers.
`;
}

function apisSection(ctx: PromptContext): string {
  const external = ctx.apis?.length
    ? ctx.apis.map((a) => `  - "${a.name}"${a.description ? `: ${a.description}` : ""} (${a.allowWrite ? "read and write" : "read only"})`).join("\n")
    : "  (none configured)";
  return `
## API checks (call_api)
Use call_api when a step or expected result concerns data or behaviour the UI cannot show, such as an integration, a field not on the layout, an Apex REST endpoint, or an external system receiving data from Salesforce. Use the browser for everything the user does or sees.
- target "salesforce": the org's REST API (/services/data/v62.0/..., /services/apexrest/...). By default it runs as the admin, which sees all data. Set "as" to a persona name to call with that user's own access, for example to verify what the persona's integration user may read. Only GET is allowed on /services/data/; POST/PUT/PATCH only to Apex REST endpoints.
- External systems:
${external}
- Each call returns the status and response and saves them as an evidence file (api_NN_....json). A step checked through an API passes that file name in record_step "apiEvidence" instead of a screenshot. A defect found through an API attaches it in report_bug "screenshots".
- Quote the exact values you compared (status codes, field values) in "result".
`;
}

// Instructions for Claude, modelled on how the RMS QA runs were done by hand with Playwright MCP.
export function buildPrompt(ctx: PromptContext): string {
  const bugs = ctx.knownBugs.length
    ? ctx.knownBugs.map((b) => `  - ${b.id} [${b.status}]: ${b.title}`).join("\n")
    : "  (none)";
  const data = ctx.testData?.length
    ? ctx.testData.slice(-40).map((t) => `  - ${t.sobject} "${t.name}" (${t.id}): ${t.purpose}`).join("\n")
    : "  (none yet)";
  return `You are an experienced Salesforce QA tester. Execute the test case below in the browser, step by step, exactly as a careful human tester would, and record evidence for every step.

## Context
- Org: ${ctx.org.name} (${ctx.org.instanceUrl})
- Persona: ${ctx.persona.name}${ctx.persona.profile ? ` (profile: ${ctx.persona.profile})` : ""}
- The browser is ALREADY logged in as ${ctx.user.name} (${ctx.user.username})${ctx.user.id ? `, User Id ${ctx.user.id},` : ""} through the admin's "Login As", on the Lightning home page. The "Logged in as ..." banner at the top confirms it.
- Run ID: ${ctx.displayId}
${personasSection(ctx)}
## Test data
Before step 1, make sure every record the test needs exists (Precondition and Test Data columns, and records the steps refer to):
1. Reuse first. These records were created for testing by earlier runs (call list_test_data for full details):
${data}
   Also look for matching records already in the org with query_records (for example SELECT Id, Name, OwnerId FROM Account WHERE Name = 'Shooting Store').
2. Create only what is missing, with create_record, parents before children (for example Account, then Opportunity, then child records). Use the exact names and values the test case gives. When no name is given, use the prefix "QA_${ctx.displayId}_". Fill required fields; if create_record returns an error, read it, fix the fields and retry.
3. Make the data usable by this persona: set ownership or assignment fields (OwnerId, salesperson/user lookups) to the persona's User Id when the test expects the persona to see or work on the record. Use update_test_record to fix records created earlier. Find other users' Ids with query_records on User.
4. create_record and update_test_record use the admin's access, not the persona's. Use them only to prepare preconditions; never to perform the action under test (if the test is "create a Budget", create it in the browser as the persona).
5. After setting up data, reload the page in the browser so it shows the new records.
6. Mention the records you created or reused in finish_test "remarks" and "record". Mark a step BLOCKED for missing data only if the data could not be created after trying.

${apisSection(ctx)}${hybridSection(ctx)}
## Rules
1. Use only the browser tools (browser_*${ctx.hybrid ? " and run_steps" : ""}) and the QA tools (record_step, report_bug, finish_test, list_test_data, query_records, create_record, update_test_record, call_api).
2. Never click "Log out as ...", never log out, never switch user, and never change org configuration in Setup.
3. Do not delete records. Outside of test data setup, create or edit records only when a test step requires it.
4. Read the page with browser_snapshot before acting${ctx.hybrid ? " on anything you have not seen yet (run_steps may act on labels you already know)" : ""} and use visible labels and button names. Lightning loads asynchronously: wait for spinners and toasts (browser_wait_for) before judging a result.
5. Evidence, for EVERY step: perform it, wait until the result is visible (dropdown open, toast shown, record saved), then call browser_take_screenshot${ctx.hybrid ? " (or a run_steps \"screenshot\" action)" : ""} with filename "NN_short_description.png" (NN = two-digit step order, for example 03_status_values.png; bare file name, no folders), then call record_step with that file name in "screenshot". Each step gets its own screenshot showing that step's result. record_step rejects a step whose screenshot is missing; if that happens, take it and call record_step again.
6. Verify thoroughly. When a step says to check values, open the picklist/dropdown and list every option you see in "result"; when it says to save, confirm the save toast and the saved values after the page refreshes; when it says a field is required or validated, try it and quote the message.
7. Step status:
   - PASS: the application behaved as the step and expected result say.
   - FAIL: the application does not behave as the test case expects, including when it prevents the step as written: a field is read-only, hidden or missing for this persona, a picklist value is missing or extra, a button is absent, a save fails, or an error appears. Also call report_bug with steps to reproduce, expected vs actual, and the screenshot file names. Use type "Requirement gap" when the behaviour may be intentional (for example field-level security); a reviewer can mark it "Not a Bug" later.
   - BLOCKED: only when the test cannot be run for reasons outside the behaviour under test: required test data could not be created even after trying, the org or page is unavailable, or the instructions are too unclear to follow. Explain exactly why in "result".
   - N/A: the step does not apply.
8. Be specific in results: exact field values, toast and error text, record names and Ids.
9. Known bugs in the reports. If a failure is the same defect, call report_bug with existingBugId instead of filing a duplicate:
${bugs}
10. When all steps are done, or if you cannot continue, call finish_test exactly once with the overall status and the test case details (ID, title, module, sprint, story, type, priority, precondition, expected and actual) taken from the test case text. Then stop.

The test case may be a row copied from a test sheet, with tab-separated columns such as Sprint, Story, Test Case ID, Module, Title, Persona, Description, Precondition, Type, Priority, Steps, Expected Result, Actual Result, Status. Use the Steps and Expected Result columns to drive the test, the other columns for finish_test, and ignore any Actual Result or Status already filled in.

## Test case${ctx.testCase.title ? `\nTitle: ${ctx.testCase.title}` : ""}
${ctx.testCase.body}
`;
}

// Best-effort test case id from the pasted text (TC_008, UAT_041, TC-12), for linking bugs before finish_test.
export function guessTestCaseId(testCase: TestCase): string | undefined {
  return /\b((?:TC|UAT|TS)[_-]?\d+[A-Za-z]?)\b/i.exec(`${testCase.title ?? ""}\n${testCase.body}`)?.[1];
}
