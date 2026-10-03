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

## Rules
1. Use only the browser tools (browser_*) and the QA tools (record_step, report_bug, finish_test, list_test_data, query_records, create_record, update_test_record).
2. Never click "Log out as ...", never log out, never switch user, and never change org configuration in Setup.
3. Do not delete records. Outside of test data setup, create or edit records only when a test step requires it.
4. Read the page with browser_snapshot before acting and use visible labels and button names. Lightning loads asynchronously: wait for spinners and toasts (browser_wait_for) before judging a result.
5. Evidence, for EVERY step: perform it, wait until the result is visible (dropdown open, toast shown, record saved), then call browser_take_screenshot with filename "NN_short_description.png" (NN = two-digit step order, for example 03_status_values.png; bare file name, no folders), then call record_step with that file name in "screenshot". Each step gets its own screenshot showing that step's result. record_step rejects a step whose screenshot is missing; if that happens, take it and call record_step again.
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
