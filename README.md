# Salesforce QA Agent

A reusable, AI-driven QA agent for Salesforce orgs.

- **Chrome extension** (`packages/extension`): floating button and panel on Salesforce pages. You paste a test case, pick an org and persona, and watch the results.
- **Local agent server** (`packages/server`): runs on `127.0.0.1`. It holds the Claude API key, drives an isolated Playwright browser as the chosen persona, and stores evidence.
- **Shared** (`packages/shared`): types and schemas used by both.

## Status

Phase 1 complete (walking skeleton). A run logs in to the org as the persona's Salesforce user in a separate Playwright browser, screenshots Lightning home, and reports PASS or BLOCKED. AI execution of the pasted test case comes in Phase 2.

## How persona authentication works

Personas are real Salesforce users. Nobody types a persona's password.

1. **Connect each org once as an admin** who has the **Login As** permission. A Playwright browser (not your Chrome) opens at the org's My Domain login. You log in once, MFA included, and the admin session is saved to `auth/<org>/admin.json`.
2. **Add personas** by searching the org's users in the panel and picking one, for example *Sales Manager → Priya Shah*.
3. **Each run** starts a fresh, isolated Playwright browser with the admin session. It **Logs In As** the persona's user through `/servlet/servlet.su`, the same thing the **Login** button on a user's Setup page does. It confirms the *"Logged in as <user>"* banner, then tests. The browser is discarded afterwards.

Your own Chrome session is never used or changed. Reconnect the org only when Salesforce expires the admin session; the run tells you when that happens.

## Setup

```powershell
npm install
Copy-Item .env.example .env              # then set AGENT_TOKEN
npm run check                            # typecheck + lint + tests
```

`config/orgs.json` is created automatically: each Salesforce org you open the panel on is detected from its address and saved.

Generate a strong `AGENT_TOKEN` for `.env`:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ([BitConverter]::ToString($b) -replace '-','').ToLower()
```

## Daily use

1. **Start the server** and keep the terminal open:
   ```powershell
   npm run dev
   ```
2. **Open any Salesforce page** and click the shield button (bottom right). The org is detected from the page address, for example `rms--dev.sandbox.lightning.force.com` becomes **RMS - DEV**.
3. **Connect org** (first time only): log in as the admin in the window that opens.
4. **+ Add** a persona: search for the Salesforce user, pick them, and name the persona.
5. **Paste a test case** and click **Run test**.

### Running many test cases from Excel / CSV

In the panel, switch to **Upload file (Excel / CSV)** and drop a `.xlsx` or `.csv` file (max 5 MB).

- **Required columns:** TC ID, Title, Steps, Expected Result. Optional columns include Sprint, Story, Module, Persona, Description, Pre-Req, Type, Priority and Test Data. Header names are matched loosely ("Test Case ID", "Precondition", …), and the header row may sit below a title row. Actual Result / Status columns are ignored.
- **Review before running:** the panel shows how many test cases were detected and lists them as QUEUED. Rows without a TC ID, Steps or Expected Result are marked INVALID and never run. If a column is missing, the panel names it and nothing runs.
- **Persona:** the Persona cell is matched to the org's personas. Rows without a match run as the Persona selected in the panel.
- **Running:** **Run Selected** or **Run All** runs the rows **one at a time**, each through the normal single-test flow (Login As, Claude, screenshots, execution report, bug reports). **Stop remaining** cancels rows that have not started.
- **Results:** a summary (Total / Passed / Failed / Blocked), each TC ID linking to its report entry, and **Open batch in report** (`Test_Execution_Report.html#suite=SUITE-…`).

### Tests with several users (multi-persona)

Some tests need more than one user, for example Sales submits a discount and the Sales Manager approves it.

- **Single test:** pick the first persona as usual, then tick the others under **Also involves**.
- **Excel / CSV:** list the personas in the Persona cell, first one first: `Sales User, Sales Manager` (also `+`, `;`, `->`, `then`).

Every persona logs in through Login As before the test starts and gets **its own browser** for the whole run. Claude performs each step in the browser of the persona the step is for, and the step is labelled with the persona (`[Sales Manager] Approve the discount`). Up to 4 personas per test. Right after the logins, the run checks that every session is still active. If Salesforce ended an earlier Login As when a later one started, the run is BLOCKED with that explanation.

### API checks (integration testing)

Claude can call APIs in a test (`call_api`) to check what the UI cannot show:

- **The org's REST API** (`/services/data/...`, `/services/apexrest/...`): as the admin, or as one of the run's personas to check that user's own access. Only GET is allowed on `/services/data/`. POST/PUT/PATCH are allowed only to Apex REST endpoints, for example to simulate an external system pushing data in.
- **External systems** the org integrates with, listed in `config/apis.json` (copy `config/apis.example.json`). Only these base URLs can be called. They are read-only unless `"allowWrite": true`. Secrets go in `.env` and are referenced as `${NAME}` in headers, so Claude never sees them.

Each call's request and response are saved as evidence (`api_NN_....json`) next to the screenshots. They are shown in the panel and linked from the execution report, and a step checked through an API uses that file as its evidence instead of a screenshot.

### Jira story → test cases

The **Jira story** tab turns a pasted story into test cases. Nothing runs in Salesforce until you start the approved ones.

1. Paste the story (summary, description, acceptance criteria, rules, notes) and optionally its Jira key, then click **Generate test cases**. It takes about a minute.
2. Claude lists the acceptance criteria and requirements. It then writes test cases where they apply: positive, negative, boundary and edge, validation, permission and persona, data integrity, integration, and regression. Negative cases are favoured. Each case has the Test Case ID, Jira Story ID, Module, Scenario, Description, Type, Priority, Persona, Preconditions, numbered Steps, Test Data and Expected Result, and is linked to the criteria it covers. Duplicate cases are dropped.
3. Review each case: **Approve**, **Reject**, or **Edit** any field. The coverage panel shows traceability, criteria without a case, gaps, assumptions, questions for the business, and possibly affected areas.
4. **Export all to Excel** or **Export approved**. The sheet has the Test Cases, Traceability and Notes tabs, plus empty Actual Result, Status and Bug ID columns. The same file can be uploaded again in **Upload file**.
5. **Run approved (N)** runs only the approved cases, one at a time, through the normal batch runner. It uses the selected project and the Fast execution switch, and the Upload file tab shows the progress.

Generated cases and exports are saved in `<project>/<org>/Test Cases/`, or in `qa/test-cases/` without a project.

To start over, click **New story**. **Recent stories** reopens an earlier story for the org. **Delete story** removes the shown story's saved test cases; Excel files you exported are kept.

### Sanity and Regression test sets

The **Test sets** tab keeps named sets of test cases per org (and project), run with one click.

- **Create** a set from **Upload file** (**Save as test set** for the selected rows) or from the **Jira story** tab (**Save approved as test set**). Choose **Sanity** (a quick check of the main flows) or **Regression** (the full set, re-run after every change).
- **Run** starts the set as a normal batch, using the selected persona, project and Fast execution switch. Progress shows in **Upload file**.
- **Re-check failures once** is on by default for sets and is an option for uploaded files. Every FAIL or BLOCKED case is run once more:
    - Failing again makes it a **confirmed failure**.
    - Passing the second time marks it **flaky**. Its bug from the first run stays, for you to review.
- **Results** compares the latest finished run with the one before: **New failure**, **Still failing**, **Fixed**, **Flaky**, **Passing**, **New**, **Not run**. New failures are listed first, each linked to its report entry.
- Sets are saved in `<project>/<org>/Test Sets/`, or in `qa/test-sets/<org>/` without a project. The last 20 runs of each set are kept. Deleting a set keeps its runs' reports and screenshots.

### Fast execution switch

The **Fast execution** switch in the panel applies to the runs you start (single tests, uploaded files and approved Jira cases). **Off** runs exactly as before.

**On** changes three things:
- Claude starts while the persona logs in.
- Claude records several finished steps in one call. Each step is still its own entry with its own screenshot.
- Claude is told which records the last run of the same test case used.

Validations, screenshots, negative checks and the PASS/FAIL/BLOCKED rules are the same in both modes. `FAST_EXECUTION=true` in `.env` sets the default for runs that don't say.

### Projects: folders for reports and notes

The **Project** section of the panel keeps each project's reports apart, per Salesforce org:

```
QA-Workspace/
  Projects/
    RMS/
      project.json                 (the project's orgs and their folder names)
      TMCDEV/
        Test Execution Reports/    Test_Execution_Report.html, execution-data.js, one RUN-…/ folder per run
        Bug Reports/               Bug_Report.html, bug-data.js, one BUG-…/ folder of evidence per bug
        Notes/                     one .md file per note
        Test Cases/                test cases generated from Jira stories, and their Excel exports
        Test Sets/                 saved Sanity and Regression sets with their run history
      UAT/
        …
  assets/                          shared styles and scripts of the report pages
```

- **+ New project** creates `Projects/<name>/`. Selecting a project adds a folder for the org selected above. The folder is named after the org's environment, so `DRIVE-ENERGY-4828 - TMCDEV` becomes `TMCDEV`.
- **Runs started with a project selected** (single test or Excel/CSV batch) save their execution report, screenshots, bugs and bug evidence in that project's folder for the org the run actually used. Each run has its own `RUN-…` folder with its screenshots and `execution.json`, so nothing is overwritten. Bug numbers start at BUG-001 in each project and org.
- **Test Execution Reports / Bug Reports** open that folder's reports, so TMCDEV shows only TMCDEV runs and UAT only UAT runs. **Notes** lists, creates, edits and deletes the folder's notes. **Open folder** shows the folder in File Explorer.
- **No project (shared reports)** works as before: runs are saved in `qa/`, and reports opened from the panel are filtered to the selected org. Runs recorded before projects existed stay in `qa/` unchanged. They are not moved into a project, because their project is unknown. Records without an org show as **Unassigned** in the org filter.
- All folder work is done by the local agent server; the extension cannot write files itself. Set `QA_WORKSPACE_DIR` in `.env` to keep the workspace elsewhere, for example `D:\QA-Workspace`. Project and folder names may use letters, digits, spaces and `- _ . & ( ) ' +`.

### How Claude drives the browser (hybrid execution)

Claude reads the test case, decides every action and judges every result. It has two ways to act in the browser:

- **Single browser tools** (`browser_snapshot`, `browser_click`, ...): one decision per action. Claude uses these to explore pages it has not seen yet and to handle anything dynamic: conditional fields, unexpected popups or errors, and negative scenarios.
- **`run_steps`**: several actions Claude has already decided on, done in one call. It covers navigate, click, fill, select, lookup, check, upload, the waits, reading fields and picklist options, verify checks, and evidence screenshots. Elements are found by visible label, role or text. Each action waits for Lightning spinners to clear, so no fixed waits are needed. The result is a short line per action plus any toasts, errors and dialogs on the page.

`run_steps` holds no business logic. It stops at the first element it cannot find for certain (missing or ambiguous), at an unexpected dialog, or at a check that does not match. Claude then takes over with the single tools. Evidence and PASS/FAIL/BLOCKED rules are the same in both modes. Screenshots taken through `run_steps` are saved as evidence but not sent to Claude.

Each run logs its cost and speed (`Metrics (...)` in the panel log, `metrics` in `runs/<id>/run.json`): turns, tokens, browser actions, batches and fallbacks, snapshots, screenshots, and fixed waits. Set `HYBRID_EXECUTION=false` in `.env` to go back to one Claude decision per browser action.

### Checking test cases against the BRD / requirement sheet

After uploading test cases, the **Check test cases against requirements** section (optional) checks the selected rows against a requirements document. Nothing runs in Salesforce and no org connection is needed.

1. Add the BRD or requirement sheet: PDF (with selectable text), Word `.docx`, Excel `.xlsx`, `.csv`, `.txt` or `.md`, up to 10 MB.
2. Click **Analyse N test cases**. Claude reads the document, lists its requirements, and gives each test case a verdict:
   - **Correct**: traceable to a requirement and matches it.
   - **Needs update**: mostly right, but a value, step, precondition or persona should change (a corrected version is suggested).
   - **Incorrect**: contradicts the requirement (a corrected version is suggested).
   - **Not traceable**: no requirement covers it.
3. It then lists **missing test cases** (requirements no test case checks, each with a suggested test case) and **questions for the business** (ambiguities in the requirements).

Progress shows in the panel; one review runs at a time. **Open review report** opens `qa/reviews/Test_Case_Review.html`, which shows requirement coverage, the verdicts with suggested fixes, and earlier reviews (data in `qa/reviews/review-data.js`).

The same is available from the terminal:

```powershell
npm run connect -- --org rms-dev      # one-time admin login for an org
npm run connections                   # orgs, admin connection, personas
npm run connections -- --verify       # also check each admin session still works
```

Set `HEADLESS=false` in `.env` to watch test runs in a visible browser window.

## Install the Chrome extension

```powershell
npm run build:extension
```

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick `packages\extension\dist`.
3. The settings page opens when you click the extension's toolbar icon. Paste your `AGENT_TOKEN` and click **Save and test connection**.

After changing extension code, run `npm run build:extension` again. Then click the reload icon on the extension card in `chrome://extensions` and refresh the Salesforce tab.

## Org config (`config/orgs.json`)

Written automatically by the panel. You can also edit it by hand:

```json
{
  "orgs": [{
    "id": "acme-uat",
    "name": "ACME - UAT",
    "loginUrl": "https://acme--uat.sandbox.my.salesforce.com",
    "instanceUrl": "https://acme--uat.sandbox.lightning.force.com",
    "personas": [
      { "id": "sales-manager", "name": "Sales Manager", "username": "priya.shah@acme.com.uat", "userId": "005bc00000UT0rSAAT", "userFullName": "Priya Shah", "profile": "RMS Sales Manager" }
    ]
  }]
}
```

- **`id`s** are lowercase slugs; org ids become folder names under `auth/`.
- **`name`:** display name; rename freely.
- **`username`:** the Salesforce user to Login As. **`userId`** is optional; it's looked up from the username if missing.

## Server API

All routes except `/health` need `Authorization: Bearer <AGENT_TOKEN>`. The WebSocket takes `?token=` instead, because browsers can't set headers on it.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness check |
| `GET /orgs` | Orgs and personas from `config/orgs.json` (re-read on each call) |
| `POST /orgs/detect` | Register the org behind a Salesforce hostname: `{ hostname }` |
| `GET /connections` | Which orgs have a saved admin session, or a connect in progress |
| `POST /orgs/:orgId/connect` | Open the one-time admin login window on this machine |
| `GET /orgs/:orgId/users?q=` | Search the org's active users (via the admin session) |
| `POST /orgs/:orgId/personas` | Add a persona: `{ name, username, userId?, userFullName?, profile? }` |
| `DELETE /orgs/:orgId/personas/:personaId` | Remove a persona |
| `POST /runs` | Queue a run: `{ orgId, personaId, testCase: { title?, body } }` |
| `POST /suites/parse` | Read an uploaded Excel/CSV (`{ orgId, fileName, data: base64 }`) and return the detected rows; runs nothing |
| `POST /suites` | Queue selected rows as one batch: `{ orgId, fileName?, defaultPersonaId?, cases: [...] }` |
| `GET /suites/:id`, `POST /suites/:id/cancel` | Batch progress and summary; cancel rows not yet started |
| `GET /runs`, `GET /runs/:id` | List or fetch runs (in memory; also written to `runs/<id>/run.json`) |
| `GET /runs/:id/evidence/:file` | Screenshot or `run.json` for a run |
| `WS /runs/:id/events` | Current state, then live `RunEvent`s until the run completes |

The server listens on `127.0.0.1` only. It also rejects non-loopback `Host` headers (DNS rebinding) and web-page `Origin`s. Only the Chrome extension or non-browser clients can call it.

## Folders

| Path | Purpose | Committed? |
|---|---|---|
| `config/orgs.json` | Orgs and personas (URLs, labels and usernames; no passwords) | No (the example file is) |
| `auth/<org>/admin.json` | Saved admin session per org | No: treat as an admin password |
| `runs/` | Screenshots, logs, and results per run | No |
| `packages/extension/dist/` | Built extension to load in Chrome | No (build output) |
