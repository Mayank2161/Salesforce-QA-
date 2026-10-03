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
