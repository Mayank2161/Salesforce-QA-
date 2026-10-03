import { access, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { overallVerdict } from "@sfqa/shared";
import type { BugRef, Org, Persona, Run, StepResult } from "@sfqa/shared";
import type { AgentBridge } from "../agent/bridge.ts";
import { runClaude, type ClaudeSettings } from "../agent/claude.ts";
import { buildPrompt, guessTestCaseId } from "../agent/prompt.ts";
import type { BugReport, Create, FinishReport, ListTestData, Query, StepReport, Update } from "../agent/protocol.ts";
import { adminApi } from "../salesforce/api.ts";
import { allowedObjectsHint, checkedFields, checkedSoql, compactRows, isAllowedSObject } from "../testdata/rules.ts";
import { loadOrgsConfig } from "../config/orgs.ts";
import { EVIDENCE_NAME, reportTimestamp, type QaWorkspace, type TestDataRecord } from "../reports/workspace.ts";
import { launchBrowser, type BrowserSettings } from "../salesforce/browser.ts";
import { openAsPersona } from "../salesforce/login-as.ts";
import { readAdminMeta } from "../salesforce/session.ts";
import type { RunStore } from "./store.ts";

export interface RunnerDeps {
  store: RunStore;
  orgsConfigPath: string;
  authDir: string;
  runsDir: string;
  browser: BrowserSettings;
  // Optional so the login-only path can be tested without Claude or the qa/ folder.
  agent?: {
    bridge: AgentBridge;
    qa: QaWorkspace;
    claude: ClaudeSettings;
    serverUrl: string;
    qaMcpScript: string;
    playwrightMcpCli: string;
  };
}

const now = () => new Date().toISOString();

// Runs execute one at a time so parallel browsers don't compete for the same admin session.
export function createRunner(deps: RunnerDeps): (run: Run) => void {
  let tail = Promise.resolve();
  return (run) => {
    tail = tail.then(() => executeRun(run.id, deps));
  };
}

// 1. Log in as the persona's Salesforce user (admin session + Login As) in an isolated browser.
// 2. Hand that session to a Playwright MCP browser and let Claude Code execute the test case.
// 3. Collect steps/bugs as Claude reports them; write the execution and bug reports.
export async function executeRun(runId: string, deps: RunnerDeps): Promise<void> {
  const { store, agent } = deps;
  const run = store.get(runId);
  // A batch row cancelled while waiting is already finished; skip it.
  if (!run || run.status !== "queued") return;
  const { orgId, personaId } = run.request;
  const runDir = join(deps.runsDir, runId);
  const personaState = join(runDir, "persona-state.json");
  let browser: Browser | undefined;
  let error: string | undefined;
  let finish: FinishReport | undefined;
  let testData: TestDataRecord[] = [];

  store.markRunning(runId);
  try {
    await mkdir(runDir, { recursive: true });
    const displayId = agent ? await agent.qa.nextRunId() : undefined;
    if (displayId) store.setDisplayId(runId, displayId);
    const shotsDir = displayId && agent ? agent.qa.screenshotsDir(displayId) : runDir;

    const { orgs } = await loadOrgsConfig(deps.orgsConfigPath);
    const org = orgs.find((o) => o.id === orgId);
    const persona = org?.personas.find((p) => p.id === personaId);
    if (!org || !persona) throw new Error(`Org "${orgId}" / persona "${personaId}" is no longer in config/orgs.json`);

    // Step 0: authenticate as the persona.
    const loginStart = now();
    const session = await openAsPersona({
      browser: async () => (browser = await launchBrowser(deps.browser)),
      org,
      persona,
      authDir: deps.authDir,
      log: (m) => store.log(runId, "info", m),
    });
    const loginShot = "00_login_as_persona.png";
    const screenshots: string[] = [];
    if (session.page) {
      await session.page.screenshot({ path: join(shotsDir, loginShot) });
      screenshots.push(loginShot);
    }
    store.addStep(runId, {
      index: 0,
      label: "0",
      description: `Log in to ${org.name} as ${persona.name}${persona.userFullName ? ` (${persona.userFullName})` : ""} via Login As`,
      status: session.ok ? "PASS" : "BLOCKED",
      actual: session.ok ? `Logged in as ${session.user.name} (${session.user.username})` : session.message,
      screenshots,
      startedAt: loginStart,
      finishedAt: now(),
    });

    if (session.ok && agent && displayId) {
      // Hand the logged-in session to Claude's browser, then close ours.
      await session.context.storageState({ path: personaState });
      await browser?.close();
      browser = undefined;
      const outcome = await runAgent({ deps: { ...deps, agent }, runId, runDir, displayId, shotsDir, org, persona, user: session.user, personaState });
      finish = outcome.finish;
      testData = outcome.testData;
    } else if (session.ok) {
      store.log(runId, "info", "Logged in. Test execution by Claude is not configured on this server.");
    }

    if (agent && displayId) {
      const admin = await readAdminMeta(deps.authDir, org.id);
      const otherScreenshots = (await readdir(shotsDir).catch(() => [] as string[])).filter((f) => EVIDENCE_NAME.test(f));
      await agent.qa.appendExecution(executionRecord({ run: store.get(runId)!, displayId, org, persona, finish, adminName: admin.name, otherScreenshots, testData }));
      store.log(runId, "info", `Report updated: ${displayId}`);
    }
  } catch (err) {
    error = (err as Error).message;
    store.log(runId, "error", error);
  } finally {
    await browser?.close().catch(() => undefined);
    // The persona session file is a live login; never leave it on disk.
    await rm(personaState, { force: true }).catch(() => undefined);
    store.finish(runId, error, { declared: finish?.status, summary: finish?.actual });
    await writeFile(join(runDir, "run.json"), JSON.stringify(store.get(runId), null, 2)).catch(() => undefined);
  }
}

async function runAgent(ctx: {
  deps: RunnerDeps & { agent: NonNullable<RunnerDeps["agent"]> };
  runId: string;
  runDir: string;
  displayId: string;
  shotsDir: string;
  org: Org;
  persona: Persona;
  user: { id: string; name: string; username: string };
  personaState: string;
}): Promise<{ finish?: FinishReport; testData: TestDataRecord[] }> {
  const { deps, runId, displayId, shotsDir, org, persona } = ctx;
  const { store, agent } = deps;
  const run = store.get(runId)!;
  const testCaseId = guessTestCaseId(run.request.testCase) ?? run.request.testCase.title ?? displayId;
  let finish: FinishReport | undefined;
  let stepIndex = 1;
  let stepStart = now();
  const createdData: TestDataRecord[] = [];

  const exists = (path: string) => access(path).then(() => true, () => false);
  // Playwright MCP saves a named screenshot relative to its working folder. Claude runs in shotsDir,
  // but a file that still lands in the run folder is moved into place rather than lost.
  const locateScreenshot = async (file: string): Promise<boolean> => {
    if (await exists(join(shotsDir, file))) return true;
    if (await exists(join(ctx.runDir, file))) {
      await rename(join(ctx.runDir, file), join(shotsDir, file));
      return true;
    }
    return false;
  };
  const retake = (file: string) =>
    `Screenshot "${file}" was not found. Call browser_take_screenshot with filename "${file}" (bare file name, no folder), then call this tool again.`;

  const key = agent.bridge.open(runId, {
    async step(r: StepReport) {
      // Evidence is mandatory: a step without its screenshot is rejected so Claude takes it and retries.
      if (r.status !== "N/A") {
        if (!r.screenshot) throw new Error("Every step needs a screenshot. Call browser_take_screenshot with a filename like \"03_save_toast.png\", then call record_step again with that file name in \"screenshot\".");
        if (!(await locateScreenshot(r.screenshot))) throw new Error(retake(r.screenshot));
      }
      const shots = r.screenshot && (await locateScreenshot(r.screenshot)) ? [r.screenshot] : [];
      const step: StepResult = {
        index: stepIndex++,
        label: String(r.n),
        description: r.action,
        status: r.status,
        actual: r.result,
        screenshots: shots,
        ...(r.caption && { notes: r.caption }),
        startedAt: stepStart,
        finishedAt: now(),
      };
      stepStart = now();
      store.addStep(runId, step);
      return `Recorded step ${r.n} (${r.status}).`;
    },
    async bug(r: BugReport) {
      const screenshots: { file: string; caption: string }[] = [];
      for (const s of r.screenshots) {
        if (!(await locateScreenshot(s.file))) throw new Error(retake(s.file));
        screenshots.push(s);
      }
      if (screenshots.length === 0) throw new Error("A bug needs at least one screenshot showing the defect. Add the step's screenshot file name to \"screenshots\" and call report_bug again.");
      const occurrence = { run: displayId, testCase: testCaseId, on: reportTimestamp(), note: "First found." };
      let ref: BugRef;
      if (r.existingBugId) {
        const bug = await agent.qa.addOccurrence(r.existingBugId, { ...occurrence, note: r.actual.slice(0, 300) }, { displayId, screenshots });
        if (!bug) throw new Error(`${r.existingBugId} does not exist. File it as a new bug instead (omit existingBugId).`);
        ref = { id: bug.id, title: bug.title, severity: bug.severity as BugRef["severity"], reproduced: true };
      } else {
        const bug = await agent.qa.addBug({
          title: r.title,
          module: r.module ?? "",
          linkedTestCase: testCaseId,
          linkedRun: displayId,
          reproducedIn: [occurrence],
          severity: r.severity,
          priority: r.priority ?? "",
          status: "Open",
          type: r.type ?? "Functional",
          environment: org.name,
          reportedOn: occurrence.on,
          reportedBy: `Claude Code via Playwright MCP (Login As ${ctx.user.name})`,
          record: r.record ?? "",
          stepsToReproduce: r.stepsToReproduce,
          expected: r.expected,
          actual: r.actual,
          impact: r.impact ?? "",
        }, { displayId, screenshots });
        ref = { id: bug.id, title: bug.title, severity: r.severity };
      }
      store.addBug(runId, ref);
      return ref.reproduced ? `Recorded a reproduction of ${ref.id}.` : `Filed ${ref.id}.`;
    },
    // --- Test data setup with the admin's API access ---
    async testdata(r: ListTestData) {
      const records = (await agent.qa.listTestData(org.id)).filter((t) => !r.sobject || t.sobject === r.sobject);
      if (records.length === 0) return "No test data has been created in this org yet.";
      return JSON.stringify(records.map(({ sobject, id, name, purpose, fields, createdInRun }) => ({ sobject, id, name, purpose, fields, createdInRun })), null, 1).slice(0, 12_000);
    },
    async query(r: Query) {
      const rows = compactRows(await (await adminApi(deps.authDir, org)).query(checkedSoql(r.soql)));
      const text = JSON.stringify(rows);
      return `${rows.length} row(s): ${text.length > 12_000 ? `${text.slice(0, 12_000)}... (truncated; narrow the query)` : text}`;
    },
    async create(r: Create) {
      if (!isAllowedSObject(r.sobject)) throw new Error(`Creating ${r.sobject} is not allowed. Test data may be: ${allowedObjectsHint()}.`);
      const fields = checkedFields(r.fields);
      const id = await (await adminApi(deps.authDir, org)).create(r.sobject, fields);
      const name = String(fields.Name ?? fields.LastName ?? fields.Subject ?? id);
      const record = { sobject: r.sobject, id, name, purpose: r.purpose, fields, createdInRun: displayId, testCase: testCaseId, createdOn: reportTimestamp() };
      await agent.qa.addTestData(org.id, record);
      createdData.push(record);
      store.log(runId, "info", `Test data: created ${r.sobject} "${name}" (${id}) - ${r.purpose}`);
      return `Created ${r.sobject} ${id}. Reload the page in the browser before looking for it.`;
    },
    async update(r: Update) {
      const known = (await agent.qa.listTestData(org.id)).some((t) => t.id === r.id || t.id.slice(0, 15) === r.id.slice(0, 15));
      if (!known) throw new Error(`Only records created for testing can be changed, and ${r.id} is not one. Use list_test_data to see them.`);
      const fields = checkedFields(r.fields);
      await (await adminApi(deps.authDir, org)).update(r.sobject, r.id, fields);
      await agent.qa.updateTestData(org.id, r.id, fields);
      store.log(runId, "info", `Test data: updated ${r.sobject} ${r.id} (${Object.keys(fields).join(", ")}) - ${r.reason}`);
      return `Updated ${r.sobject} ${r.id}.`;
    },
    async finish(r: FinishReport) {
      if (stepIndex === 1) throw new Error("No steps were recorded. Execute the test case steps and call record_step for each before finish_test.");
      if (finish) throw new Error("finish_test was already called. Stop now.");
      finish = r;
      return "Test finished and recorded. Stop now.";
    },
  });

  const mcpConfig = join(ctx.runDir, "mcp.json");
  const mcpOutput = join(ctx.runDir, "mcp-output");
  await writeFile(mcpConfig, JSON.stringify({
    mcpServers: {
      playwright: {
        command: process.execPath,
        args: [
          agent.playwrightMcpCli,
          "--browser", deps.browser.channel,
          "--isolated",
          "--storage-state", ctx.personaState,
          // Page snapshots and console logs (not evidence) stay out of qa/Screenshots.
          "--output-dir", mcpOutput,
          "--viewport-size", "1440,900",
          ...(deps.browser.headless ? ["--headless"] : []),
        ],
      },
      qa: {
        command: process.execPath,
        args: [agent.qaMcpScript],
        env: { SFQA_URL: agent.serverUrl, SFQA_RUN_ID: runId, SFQA_RUN_KEY: key },
      },
    },
  }, null, 2));

  try {
    const knownBugs = (await agent.qa.listBugs())
      .filter((b) => b.environment === org.name && !["Fixed", "Closed", "Rejected", "Not a Bug", "Duplicate"].includes(b.status))
      .map((b) => ({ id: b.id, title: b.title, status: b.status }));
    const result = await runClaude({
      settings: agent.claude,
      // Named screenshots are saved relative to the working folder, so this is where they land.
      cwd: shotsDir,
      mcpConfigPath: mcpConfig,
      prompt: buildPrompt({
        org, persona, user: ctx.user, displayId, testCase: run.request.testCase, knownBugs,
        testData: (await agent.qa.listTestData(org.id)).map((t) => ({ sobject: t.sobject, id: t.id, name: t.name, purpose: t.purpose })),
      }),
      onLog: (level, message) => store.log(runId, level, message),
    });
    if (result.turns) store.log(runId, "info", `Claude finished in ${result.turns} turns${result.durationMs ? ` (${Math.round(result.durationMs / 1000)}s)` : ""}.`);
    if (!result.ok) store.log(runId, "error", result.error ?? "Claude stopped with an error.");
    if (!finish) {
      // Claude stopped without a verdict: the run cannot pass.
      store.addStep(runId, {
        index: stepIndex++,
        label: "-",
        description: "Complete the test case",
        status: "BLOCKED",
        actual: `The agent stopped before finishing. ${result.error ?? "No finish_test call was made."}`,
        screenshots: [],
        startedAt: stepStart,
        finishedAt: now(),
      });
    }
  } finally {
    agent.bridge.close(runId);
    await rm(mcpConfig, { force: true }).catch(() => undefined);
    await rm(mcpOutput, { recursive: true, force: true }).catch(() => undefined);
  }
  return { finish, testData: createdData };
}

// Execution record in the RMS QA report format (qa/reports/execution-data.js).
export function executionRecord(o: {
  run: Run; displayId: string; org: Org; persona: Persona; finish?: FinishReport; adminName?: string;
  otherScreenshots?: string[]; testData?: TestDataRecord[];
}) {
  const { run, finish } = o;
  // Same rule the run itself uses, so the report and the panel always agree.
  const verdict = run.verdict ?? overallVerdict(run.steps, finish?.status);
  const user = o.persona.userFullName ?? o.persona.username ?? "";
  return {
    runId: o.displayId,
    testCaseId: finish?.testCaseId ?? guessTestCaseId(run.request.testCase) ?? "",
    sprint: finish?.sprint ?? "",
    story: finish?.story ?? "",
    title: finish?.title ?? run.request.testCase.title ?? run.request.testCase.body.split("\n")[0]!.slice(0, 120),
    module: finish?.module ?? "",
    persona: user ? `${o.persona.name} (${user})` : o.persona.name,
    type: finish?.type ?? "",
    priority: finish?.priority ?? "",
    environment: o.org.name,
    executedOn: reportTimestamp(new Date(run.startedAt ?? run.createdAt)),
    executedBy: `Claude Code via Playwright MCP (Login As ${user || o.persona.name}${o.adminName ? `, session of ${o.adminName}` : ""})`,
    record: finish?.record ?? "",
    status: verdict,
    remarks: finish?.remarks ?? (finish ? "" : "The agent did not finish the test case."),
    precondition: finish?.precondition ?? "",
    steps: run.steps.map((s) => ({ n: s.label ?? String(s.index), action: s.description, status: s.status, result: s.actual ?? "" })),
    expected: finish?.expected ?? "",
    actual: finish?.actual ?? run.steps.at(-1)?.actual ?? "",
    // Each file once, captioned by the first step that used it; then any other evidence from the run
    // (for example screenshots taken only for a bug), in file-name order.
    screenshots: [
      ...new Map(run.steps.flatMap((s) => s.screenshots.map((file) => [file, {
        file: `../Screenshots/${o.displayId}/${file}`,
        caption: (s.notes ?? `Step ${s.label ?? s.index}: ${s.description}`).slice(0, 120),
      }] as const)).reverse()).values(),
    ].reverse().concat(
      (o.otherScreenshots ?? [])
        .filter((file) => !run.steps.some((s) => s.screenshots.includes(file)))
        .sort()
        .map((file) => ({ file: `../Screenshots/${o.displayId}/${file}`, caption: file.replace(/\.(png|jpe?g)$/i, "").replace(/^\d+_/, "").replace(/_/g, " ") })),
    ),
    bugs: [...new Set(run.bugs.map((b) => b.id))],
    testCaseText: run.request.testCase.body,
    // Batch this run belonged to (uploaded file), for filtering the report.
    ...(run.request.suiteId && { suite: run.request.suiteId }),
    // Records this run created as test data (reusable by later runs; see qa/test-data/).
    testData: (o.testData ?? []).map((t) => ({ sobject: t.sobject, id: t.id, name: t.name, purpose: t.purpose })),
  };
}

// Removes files a killed run can leave behind: live persona sessions and per-run tool configs.
// Called at server start, when no run can be in progress.
export async function cleanupStaleRuns(runsDir: string): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    for (const leftover of ["persona-state.json", "mcp.json", "mcp-output"]) {
      const path = join(runsDir, entry.name, leftover);
      if (await access(path).then(() => true, () => false)) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}