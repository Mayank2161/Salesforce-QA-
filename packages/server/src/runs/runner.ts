import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { overallVerdict } from "@sfqa/shared";
import type { BugRef, Org, Persona, Run, RunMetrics, StepResult } from "@sfqa/shared";
import { describeApiCall, performApiCall } from "../agent/api-call.ts";
import type { AgentBridge, AgentHandlers } from "../agent/bridge.ts";
import { runClaude, type ClaudeSettings } from "../agent/claude.ts";
import type { BrowserMcpConfig } from "../agent/browser-mcp.ts";
import type { SessionMetrics } from "../agent/metrics.ts";
import { buildPrompt, guessTestCaseId } from "../agent/prompt.ts";
import { API_EVIDENCE, type BugReport, type CallApi, type Create, type FinishReport, type ListTestData, type Query, type StepReport, type StepsReport, type Update } from "../agent/protocol.ts";
import { loadExternalApis } from "../config/apis.ts";
import { adminApi, sidFromCookies } from "../salesforce/api.ts";
import { allowedObjectsHint, checkedFields, checkedSoql, compactRows, isAllowedSObject } from "../testdata/rules.ts";
import { loadOrgsConfig } from "../config/orgs.ts";
import { EVIDENCE_NAME, reportTimestamp, type QaWorkspace, type TestDataRecord } from "../reports/workspace.ts";
import { launchBrowser, type BrowserSettings } from "../salesforce/browser.ts";
import { bannerShowsUser, openAsPersona } from "../salesforce/login-as.ts";
import { myDomainUrl, readAdminMeta } from "../salesforce/session.ts";
import type { ProjectStore } from "../projects/store.ts";
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
    // Hybrid execution: each persona's browser also offers run_steps (generic batched actions).
    // Off: the plain Playwright MCP browser, one Claude decision per browser action.
    hybrid?: boolean;
    browserMcpScript?: string;
    // FAST_EXECUTION: start Claude while Login As runs, let Claude record several steps per call, and
    // tell it which records the previous run of the same test case used. Off: the current path.
    fast?: boolean;
    // Project folders: a run with a project saves its reports in <project>/<org>/ instead of qa/.
    projects?: ProjectStore;
    // config/apis.json: external systems tests may call with call_api.
    apisConfigPath?: string;
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
// One persona taking part in a run, with its logged-in session handed to its own browser.
export interface RunPersona {
  persona: Persona;
  user: { id: string; name: string; username: string };
  // Saved session of the logged-in persona (a live login: deleted when the run ends).
  stateFile: string;
  // MCP server name of this persona's browser: "playwright" for the first persona, then "playwright_2", ...
  server: string;
  // Lightning origin the persona landed on, for org-relative URLs in run_steps.
  baseUrl?: string;
}

export const browserServer = (i: number) => (i === 0 ? "playwright" : `playwright_${i + 1}`);
const personaStateFile = (runDir: string, i: number) => join(runDir, i === 0 ? "persona-state.json" : `persona-state-${i + 1}.json`);

export async function executeRun(runId: string, deps: RunnerDeps): Promise<void> {
  const { store, agent } = deps;
  const run = store.get(runId);
  // A batch row cancelled while waiting is already finished; skip it.
  if (!run || run.status !== "queued") return;
  const { orgId } = run.request;
  const personaIds = [run.request.personaId, ...(run.request.extraPersonaIds ?? [])];
  const runDir = join(deps.runsDir, runId);
  let browser: Browser | undefined;
  let error: string | undefined;
  let finish: FinishReport | undefined;
  let testData: TestDataRecord[] = [];
  let session: SessionMetrics | undefined;
  let shotsDirUsed: string | undefined;
  let reports: QaWorkspace | undefined;
  let stopEarly: (() => void) | undefined;
  let earlyAgent: Promise<AgentOutcome> | undefined;

  store.markRunning(runId);
  try {
    await mkdir(runDir, { recursive: true });
    const { orgs } = await loadOrgsConfig(deps.orgsConfigPath);
    const org = orgs.find((o) => o.id === orgId);
    const personas = personaIds.map((id) => org?.personas.find((p) => p.id === id));
    const missing = personaIds.filter((_, i) => !personas[i]);
    if (!org || missing.length) throw new Error(`Org "${orgId}" / persona "${missing.join(", ") || personaIds[0]}" is no longer in config/orgs.json`);

    // Reports go to the project's folder for this run's actual org, or to the shared qa/ folder.
    if (agent) reports = await reportsFor(run, org, agent, store, runId);
    const displayId = reports ? await reports.nextRunId() : undefined;
    if (displayId) store.setDisplayId(runId, displayId);
    const shotsDir = displayId && reports ? reports.screenshotsDir(displayId) : runDir;
    shotsDirUsed = shotsDir;
    const multi = personas.length > 1;
    const phases: { loginMs?: number; reportMs?: number } = {};
    const loginStarted = Date.now();

    // Fast mode: start Claude now, while Login As runs. The prompt only needs the persona's user from
    // the org config. The browser waits for the login session file, tools that change data wait for
    // the login to succeed, and a failed login stops Claude before it does anything in Salesforce.
    let loginGate: Deferred<boolean> | undefined;
    // The run's own choice (panel switch) wins over the server default.
    const fast = Boolean(agent && (run.request.fast ?? agent.fast));
    const early = agent && displayId && reports && fast && agent.hybrid && agent.browserMcpScript ? earlyPersonas(personas as Persona[], org, runDir) : undefined;
    if (agent && displayId && reports && early) {
      loginGate = deferred<boolean>();
      const gate = loginGate;
      stopEarly = () => gate.resolve(false);
      earlyAgent = runAgent({ deps: { ...deps, agent }, reports, runId, runDir, displayId, shotsDir, org, personas: early, loginGate: loginGate.promise, fast });
      earlyAgent.catch(() => undefined);
    }

    // Step 0: authenticate as each persona, each in its own isolated browser context (Login As).
    const sessions: { persona: Persona; session: Extract<Awaited<ReturnType<typeof openAsPersona>>, { ok: true }> }[] = [];
    for (const [i, persona] of (personas as Persona[]).entries()) {
      const loginStart = now();
      const session = await openAsPersona({
        browser: async () => (browser ??= await launchBrowser(deps.browser)),
        org,
        persona,
        authDir: deps.authDir,
        log: (m) => store.log(runId, "info", m),
      });
      const label = multi ? `0${String.fromCharCode(97 + i)}` : "0";
      const shot = i === 0 ? "00_login_as_persona.png" : `${label}_login_as_${persona.id}.png`;
      const screenshots: string[] = [];
      if (session.page) {
        await session.page.screenshot({ path: join(shotsDir, shot) });
        screenshots.push(shot);
      }
      store.addStep(runId, {
        index: 0,
        label,
        description: `Log in to ${org.name} as ${persona.name}${persona.userFullName ? ` (${persona.userFullName})` : ""} via Login As`,
        status: session.ok ? "PASS" : "BLOCKED",
        actual: session.ok ? `Logged in as ${session.user.name} (${session.user.username})` : session.message,
        screenshots,
        startedAt: loginStart,
        finishedAt: now(),
      });
      if (!session.ok) break; // the test cannot run without every persona
      sessions.push({ persona, session });
    }

    // Each Login As starts from the same admin session. Make sure a later login did not end an earlier one.
    let allLoggedIn = sessions.length === personas.length;
    if (allLoggedIn && multi) {
      const checkStart = now();
      const ended: string[] = [];
      for (const { persona, session } of sessions.slice(0, -1)) {
        await session.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        const banner = session.page.getByText(/Logged in as/i).first();
        const text = await banner.waitFor({ timeout: 30_000 }).then(() => banner.innerText(), () => "");
        if (!bannerShowsUser(text, session.user)) ended.push(persona.name);
      }
      store.addStep(runId, {
        index: 0,
        label: "0z",
        description: `Confirm all ${sessions.length} persona sessions are active at the same time`,
        status: ended.length ? "BLOCKED" : "PASS",
        actual: ended.length
          ? `Salesforce ended the Login As session of ${ended.join(", ")} when the next persona logged in, so this org cannot run several personas at once. Split the test case into one test per persona.`
          : `All persona sessions are active: ${sessions.map((s) => s.session.user.name).join(", ")}.`,
        screenshots: [],
        startedAt: checkStart,
        finishedAt: now(),
      });
      allLoggedIn = ended.length === 0;
    }

    if (allLoggedIn && agent && displayId) {
      // Hand each logged-in session to its own browser for Claude, then close ours.
      const runPersonas: RunPersona[] = [];
      for (const [i, { persona, session }] of sessions.entries()) {
        const stateFile = personaStateFile(runDir, i);
        await session.context.storageState({ path: stateFile });
        runPersonas.push({ persona, user: session.user, stateFile, server: browserServer(i), baseUrl: new URL(session.page.url()).origin });
      }
      await browser?.close();
      browser = undefined;
      phases.loginMs = Date.now() - loginStarted;
      let outcome: AgentOutcome;
      if (earlyAgent && loginGate) {
        loginGate.resolve(true);
        outcome = await earlyAgent;
      } else {
        outcome = await runAgent({ deps: { ...deps, agent }, reports: reports!, runId, runDir, displayId, shotsDir, org, personas: runPersonas, fast });
      }
      finish = outcome.finish;
      testData = outcome.testData;
      session = outcome.metrics && { ...outcome.metrics, ...(fast && { fast: true }), phases: { ...outcome.metrics.phases, ...phases } };
    } else if (earlyAgent && loginGate) {
      // The login failed: stop the Claude session that was started early. Its cost still counts.
      loginGate.resolve(false);
      const outcome = await earlyAgent;
      session = outcome.metrics && { ...outcome.metrics, fast: true, phases: { ...outcome.metrics.phases, loginMs: Date.now() - loginStarted } };
    } else if (allLoggedIn) {
      store.log(runId, "info", "Logged in. Test execution by Claude is not configured on this server.");
    }

    if (reports && displayId) {
      const reportStart = Date.now();
      const admin = await readAdminMeta(deps.authDir, org.id);
      const otherScreenshots = (await readdir(shotsDir).catch(() => [] as string[])).filter((f) => EVIDENCE_NAME.test(f));
      const target = reports;
      await target.appendExecution(executionRecord({
        run: store.get(runId)!, displayId, org, persona: personas[0]!, extraPersonas: personas.slice(1) as Persona[], finish, adminName: admin.name, otherScreenshots, testData,
        screenshotRef: (file) => target.screenshotRef(displayId, file),
        fast,
      }));
      const where = store.get(runId)?.reports;
      store.log(runId, "info", `Report updated: ${displayId}${where ? ` (${where.project} / ${where.folder})` : ""}`);
      if (session) session = { ...session, phases: { ...session.phases, reportMs: Date.now() - reportStart } };
    }
  } catch (err) {
    error = (err as Error).message;
    store.log(runId, "error", error);
  } finally {
    // An early-started Claude session never outlives its run.
    stopEarly?.();
    await earlyAgent?.catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (session) {
      const evidence = (await readdir(shotsDirUsed ?? runDir).catch(() => [] as string[])).filter((f) => /.(png|jpe?g)$/i.test(f));
      const metrics: RunMetrics = {
        mode: agent?.hybrid && agent.browserMcpScript ? "hybrid" : "classic",
        totalMs: Date.now() - new Date(store.get(runId)!.startedAt!).getTime(),
        ...session,
        screenshots: evidence.length,
      };
      store.setMetrics(runId, metrics);
      store.log(runId, "info", describeMetrics(metrics));
    }
    // Persona session files are live logins; never leave them on disk.
    for (let i = 0; i < personaIds.length; i++) await rm(personaStateFile(runDir, i), { force: true }).catch(() => undefined);
    store.finish(runId, error, { declared: finish?.status, summary: finish?.actual });
    await writeFile(join(runDir, "run.json"), JSON.stringify(store.get(runId), null, 2)).catch(() => undefined);
  }
}

// Tool servers for one run: a Playwright browser per persona (each starting from that persona's
// logged-in session) and the QA tools.
export function mcpServers(o: {
  personas: RunPersona[]; runDir: string; browser: BrowserSettings; playwrightMcpCli: string; qaMcpScript: string; serverUrl: string; runId: string; key: string;
  browserMcpScript?: string;
  // Fast mode: the QA tools include record_steps; waitForLogin: browsers wait for the session file.
  fast?: boolean;
  waitForLogin?: boolean;
}): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  o.personas.forEach((p, i) => {
    const outputDir = join(o.runDir, i === 0 ? "mcp-output" : `mcp-output-${i + 1}`);
    if (o.browserMcpScript) {
      const config: BrowserMcpConfig = {
        channel: o.browser.channel, headless: o.browser.headless, storageState: p.stateFile, outputDir, viewport: { width: 1440, height: 900 },
        ...(p.baseUrl && { baseUrl: p.baseUrl }),
        ...(o.waitForLogin && { waitForStorageState: true }),
        stepsLog: join(o.runDir, i === 0 ? "run-steps.log" : `run-steps-${i + 1}.log`),
      };
      servers[p.server] = { command: process.execPath, args: [o.browserMcpScript], env: { SFQA_BROWSER: JSON.stringify(config) } };
      return;
    }
    servers[p.server] = {
      command: process.execPath,
      args: [
        o.playwrightMcpCli,
        "--browser", o.browser.channel,
        "--isolated",
        "--storage-state", p.stateFile,
        // Page snapshots and console logs (not evidence) stay out of qa/Screenshots.
        "--output-dir", outputDir,
        "--viewport-size", "1440,900",
        ...(o.browser.headless ? ["--headless"] : []),
      ],
    };
  });
  servers.qa = {
    command: process.execPath,
    args: [o.qaMcpScript],
    env: { SFQA_URL: o.serverUrl, SFQA_RUN_ID: o.runId, SFQA_RUN_KEY: o.key, ...(o.fast && { SFQA_FAST: "1" }) },
  };
  return servers;
}

// record_steps: records each step in order through the normal record_step handler. Stops at the first
// step that is rejected (missing screenshot, unknown persona), saying which steps were recorded.
export async function recordSteps(r: StepsReport, step: (s: StepReport) => Promise<string>): Promise<string> {
  const done: string[] = [];
  for (const s of r.steps) {
    try {
      // One entry per test case step: merged entries ("2-3", "5, 6") would hide a step's own result.
      if (/\d\s*(?:[-–,&]|and|to)\s*\d/i.test(String(s.n))) {
        throw new Error(`"${s.n}" combines several steps. Record each step separately with its own number, result and screenshot.`);
      }
      await step(s);
    } catch (err) {
      throw new Error(`${done.length ? `Recorded step(s) ${done.join(", ")}. ` : ""}Step ${s.n} was NOT recorded: ${(err as Error).message} Fix it, then record step ${s.n} and the steps after it again.`, { cause: err });
    }
    done.push(String(s.n));
  }
  return `Recorded steps ${done.join(", ")}.`;
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type AgentOutcome = { finish?: FinishReport; testData: TestDataRecord[]; metrics?: SessionMetrics; loginFailed?: boolean };

// The run's personas before Login As has finished, from the org config. Undefined (start Claude after
// the login, as usual) when a persona's Salesforce user is not fully known from the config.
function earlyPersonas(personas: Persona[], org: Org, runDir: string): RunPersona[] | undefined {
  if (personas.some((p) => !p.userId || !p.username || !p.userFullName)) return undefined;
  return personas.map((p, i) => ({
    persona: p,
    user: { id: p.userId!, name: p.userFullName!, username: p.username! },
    stateFile: personaStateFile(runDir, i),
    server: browserServer(i),
    baseUrl: new URL(org.instanceUrl).origin,
  }));
}

// The report workspace for a run: its project's folder for the run's org (created on first use), or
// the shared qa/ folder when the run has no project.
async function reportsFor(run: Run, org: Org, agent: NonNullable<RunnerDeps["agent"]>, store: RunStore, runId: string): Promise<QaWorkspace> {
  const name = run.request.project;
  if (!name) return agent.qa;
  if (!agent.projects) throw new Error("Project folders are not available on this server.");
  const entry = await agent.projects.addOrg(name, org);
  const project = await agent.projects.get(name);
  store.setReports(runId, { project: project.name, folder: entry.folder });
  return agent.projects.workspace(project.name, org.id);
}

async function runAgent(ctx: {
  deps: RunnerDeps & { agent: NonNullable<RunnerDeps["agent"]> };
  // Where this run's execution and bug reports are saved.
  reports: QaWorkspace;
  runId: string;
  runDir: string;
  displayId: string;
  shotsDir: string;
  org: Org;
  personas: RunPersona[];
  // Fast mode: Claude starts before Login As has finished. Resolves true once every persona is logged
  // in (their session files are written), false if the login failed.
  loginGate?: Promise<boolean>;
  // Fast execution for this run.
  fast?: boolean;
}): Promise<AgentOutcome> {
  const { deps, runId, displayId, shotsDir, org, reports } = ctx;
  const fast = Boolean(ctx.fast);
  const stop = new AbortController();
  let loginFailed = false;
  void ctx.loginGate?.then((ok) => {
    if (ok) return;
    loginFailed = true;
    stop.abort();
  });
  // Tools that act as a persona or change Salesforce data wait for the login (reads do not).
  const requireLogin = async () => {
    if (ctx.loginGate && !(await ctx.loginGate)) throw new Error("Login As failed, so this run is stopping. Do not continue.");
  };
  const { persona, user } = ctx.personas[0]!;
  const multi = ctx.personas.length > 1;
  const { store, agent } = deps;
  const run = store.get(runId)!;
  // Persona by name or id, for record_step "persona" and call_api "as".
  // Id or user name first: two personas of a run may share a persona name (two Sales users).
  const findPersona = (name: string) => {
    const key = name.trim().toLowerCase();
    const byId = ctx.personas.find((p) => [p.persona.id, p.user.name, p.user.username].some((n) => n.toLowerCase() === key));
    if (byId) return byId;
    const byName = ctx.personas.filter((p) => p.persona.name.toLowerCase() === key);
    if (byName.length > 1) throw new Error(`Several personas are named "${name}". Use the user's name instead: ${byName.map((p) => p.user.name).join(", ")}.`);
    return byName[0];
  };
  let apiCalls = 0;
  const externalApis = await loadExternalApis(agent.apisConfigPath ?? "", org.id).catch((err: Error) => {
    store.log(runId, "warn", `External APIs not available: ${err.message}`);
    return [];
  });
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

  const handlers: AgentHandlers = {
    async step(r: StepReport) {
      // Evidence is mandatory: a step without its screenshot is rejected so Claude takes it and retries.
      const apiFiles = r.apiEvidence ?? [];
      for (const file of apiFiles) {
        if (!(await exists(join(shotsDir, file)))) throw new Error(`${file} is not an evidence file of this run. Use the file name call_api returned.`);
      }
      if (r.status !== "N/A") {
        if (!r.screenshot && apiFiles.length === 0) throw new Error("Every step needs evidence. Call browser_take_screenshot with a filename like \"03_save_toast.png\" and pass it in \"screenshot\"; for a step checked through call_api, pass the evidence file it returned in \"apiEvidence\". Then call record_step again.");
        if (r.screenshot && !(await locateScreenshot(r.screenshot))) throw new Error(retake(r.screenshot));
      }
      let who: RunPersona | undefined;
      if (multi && r.persona) {
        who = findPersona(r.persona);
        if (!who) throw new Error(`"${r.persona}" is not a persona of this run. Use one of: ${ctx.personas.map((p) => p.persona.name).join(", ")}.`);
      }
      const shots = [...(r.screenshot && (await locateScreenshot(r.screenshot)) ? [r.screenshot] : []), ...apiFiles];
      const step: StepResult = {
        index: stepIndex++,
        label: String(r.n),
        description: who ? `[${who.persona.name}] ${r.action}` : r.action,
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
        if (API_EVIDENCE.test(s.file)) {
          if (!(await exists(join(shotsDir, s.file)))) throw new Error(`${s.file} is not an evidence file of this run. Use the file name call_api returned.`);
        } else if (!(await locateScreenshot(s.file))) throw new Error(retake(s.file));
        screenshots.push(s);
      }
      if (screenshots.length === 0) throw new Error("A bug needs at least one screenshot (or call_api evidence file) showing the defect. Add the step's screenshot file name to \"screenshots\" and call report_bug again.");
      const occurrence = { run: displayId, testCase: testCaseId, on: reportTimestamp(), note: "First found." };
      let ref: BugRef;
      if (r.existingBugId) {
        const bug = await reports.addOccurrence(r.existingBugId, { ...occurrence, note: r.actual.slice(0, 300) }, { displayId, screenshots });
        if (!bug) throw new Error(`${r.existingBugId} does not exist. File it as a new bug instead (omit existingBugId).`);
        ref = { id: bug.id, title: bug.title, severity: bug.severity as BugRef["severity"], reproduced: true };
      } else {
        const bug = await reports.addBug({
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
          reportedBy: `Claude Code via Playwright MCP (Login As ${ctx.personas.map((p) => p.user.name).join(", ")})`,
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
    // --- API checks: the org's REST API (as the admin or a persona) or a configured external system ---
    async api(r: CallApi) {
      const result = await performApiCall({
        externalApis,
        evidenceDir: shotsDir,
        nextIndex: () => ++apiCalls,
        salesforce: async (as) => {
          if (!as || as.trim().toLowerCase() === "admin") {
            const api = await adminApi(deps.authDir, org);
            return { baseUrl: api.baseUrl, authorization: api.authorization() };
          }
          const p = findPersona(as);
          if (!p) throw new Error(`"${as}" is not a persona of this run. Use "admin" or one of: ${ctx.personas.map((x) => x.persona.name).join(", ")}.`);
          const state = JSON.parse(await readFile(p.stateFile, "utf8")) as { cookies: { name: string; value: string; domain: string }[] };
          const baseUrl = myDomainUrl(org);
          const sid = sidFromCookies(state.cookies, baseUrl);
          if (!sid) throw new Error(`No Salesforce session was found for ${p.persona.name}.`);
          return { baseUrl, authorization: `Bearer ${sid}` };
        },
      }, r);
      store.log(runId, "info", describeApiCall(r, result));
      return result.message;
    },
    async finish(r: FinishReport) {
      if (stepIndex === 1) throw new Error("No steps were recorded. Execute the test case steps and call record_step for each before finish_test.");
      if (finish) throw new Error("finish_test was already called. Stop now.");
      finish = r;
      return "Test finished and recorded. Stop now.";
    },
  };
  // Fast mode: several consecutive steps in one call, each validated exactly like record_step.
  if (fast) {
    handlers.steps = (r: StepsReport) => recordSteps(r, (step) => handlers.step!(step));
  }
  if (ctx.loginGate) {
    for (const kind of ["step", "steps", "bug", "finish", "create", "update", "api"] as const) {
      const handler = handlers[kind] as ((r: unknown) => Promise<string>) | undefined;
      if (handler) (handlers as Record<string, unknown>)[kind] = async (r: unknown) => { await requireLogin(); return handler(r); };
    }
  }
  const key = agent.bridge.open(runId, handlers);

  const mcpConfig = join(ctx.runDir, "mcp.json");
  const servers = mcpServers({
    personas: ctx.personas, runDir: ctx.runDir, browser: deps.browser, playwrightMcpCli: agent.playwrightMcpCli,
    qaMcpScript: agent.qaMcpScript, serverUrl: agent.serverUrl, runId, key,
    ...(agent.hybrid && agent.browserMcpScript && { browserMcpScript: agent.browserMcpScript }),
    ...(fast && { fast: true, waitForLogin: Boolean(ctx.loginGate) }),
  });
  let metrics: SessionMetrics | undefined;
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: servers }, null, 2));

  try {
    const knownBugs = (await reports.listBugs())
      .filter((b) => b.environment === org.name && !["Fixed", "Closed", "Rejected", "Not a Bug", "Duplicate"].includes(b.status))
      .map((b) => ({ id: b.id, title: b.title, status: b.status }));
    const result = await runClaude({
      settings: agent.claude,
      // Named screenshots are saved relative to the working folder, so this is where they land.
      cwd: shotsDir,
      mcpConfigPath: mcpConfig,
      allowedTools: Object.keys(servers).map((s) => `mcp__${s}`),
      prompt: buildPrompt({
        org, persona, user, displayId, testCase: run.request.testCase, knownBugs,
        testData: (await agent.qa.listTestData(org.id)).map((t) => ({ sobject: t.sobject, id: t.id, name: t.name, purpose: t.purpose })),
        ...(multi && { personas: ctx.personas.map((p) => ({ persona: p.persona, user: p.user, server: p.server })) }),
        apis: externalApis.map((a) => ({ name: a.name, description: a.description, allowWrite: a.allowWrite })),
        hybrid: Boolean(agent.hybrid && agent.browserMcpScript),
        ...(fast && { fast: true, previousRun: await previousRunOf(reports, testCaseId, org.name) }),
      }),
      onLog: (level, message) => store.log(runId, level, message),
      signal: stop.signal,
    });
    if (loginFailed) return { testData: createdData, ...(result.metrics && { metrics: result.metrics }), loginFailed: true };
    metrics = result.metrics;
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
    for (let i = 0; i < ctx.personas.length; i++) {
      await rm(join(ctx.runDir, i === 0 ? "mcp-output" : `mcp-output-${i + 1}`), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { finish, testData: createdData, metrics };
}

// The latest earlier run of the same test case in the same org: which records it used, so Claude can
// check those first instead of searching again. Never a substitute for checking they still fit.
async function previousRunOf(reports: QaWorkspace, testCaseId: string, environment: string): Promise<{ runId: string; status: string; records: string } | undefined> {
  const last = (await reports.listExecutions().catch(() => [])).filter((r) => r.testCaseId === testCaseId && r.environment === environment).at(-1);
  if (!last) return undefined;
  const created = ((last.testData as { sobject: string; name: string; id: string }[] | undefined) ?? []).map((t) => `${t.sobject} "${t.name}" (${t.id})`);
  const records = [String(last.record ?? ""), ...created].filter(Boolean).join("; ").slice(0, 600);
  return records ? { runId: last.runId, status: last.status, records } : undefined;
}

const secs = (ms?: number) => (ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`);

export function describeMetrics(m: RunMetrics): string {
  const t = m.tokens;
  const tokens = t ? `, tokens in ${t.input + t.cacheCreation + t.cacheRead} (cached ${t.cacheRead}) / out ${t.output}` : "";
  return `Metrics (${m.mode}): ${Math.round(m.totalMs / 1000)}s total, ${m.turns ?? "?"} Claude turns, ${m.browserActions} browser actions` +
    ` (${m.batches} batches, ${m.batchSteps} batched, ${m.batchFallbacks} fallbacks), ${m.snapshots} snapshots, ${m.screenshots} screenshots` +
    ` (${m.imagesToClaude} sent to Claude), ${m.fixedWaits} fixed waits (${m.fixedWaitSeconds}s), tool output ${Math.round(m.toolResultChars / 1000)}k chars${tokens}` +
    `${m.phases ? `, login ${secs(m.phases.loginMs)}, Claude start ${secs(m.phases.claudeStartupMs)}, reports ${secs(m.phases.reportMs)}` : ""}${m.fast ? ", fast execution" : ""}` +
    `${m.costUsd !== undefined ? `, ~${m.costUsd.toFixed(2)}` : ""}.`;
}

// Execution record in the RMS QA report format (qa/reports/execution-data.js).
export function executionRecord(o: {
  run: Run; displayId: string; org: Org; persona: Persona; extraPersonas?: Persona[]; finish?: FinishReport; adminName?: string;
  otherScreenshots?: string[]; testData?: TestDataRecord[];
  // Link to a run file from the report page; defaults to the shared qa/ layout.
  screenshotRef?: (file: string) => string;
  // End of the run for its duration (defaults to now, when the report is written).
  finishedAt?: number;
  // The run used fast execution.
  fast?: boolean;
}) {
  const ref = o.screenshotRef ?? ((file: string) => `../Screenshots/${o.displayId}/${file}`);
  const { run, finish } = o;
  // Same rule the run itself uses, so the report and the panel always agree.
  const verdict = run.verdict ?? overallVerdict(run.steps, finish?.status);
  const all = [o.persona, ...(o.extraPersonas ?? [])];
  const userOf = (p: Persona) => p.userFullName ?? p.username ?? "";
  const user = all.map(userOf).filter(Boolean).join(", ");
  return {
    runId: o.displayId,
    testCaseId: finish?.testCaseId ?? guessTestCaseId(run.request.testCase) ?? "",
    sprint: finish?.sprint ?? "",
    story: finish?.story ?? "",
    title: finish?.title ?? run.request.testCase.title ?? run.request.testCase.body.split("\n")[0]!.slice(0, 120),
    module: finish?.module ?? "",
    persona: all.map((p) => (userOf(p) ? `${p.name} (${userOf(p)})` : p.name)).join(" + "),
    type: finish?.type ?? "",
    priority: finish?.priority ?? "",
    environment: o.org.name,
    executedOn: reportTimestamp(new Date(run.startedAt ?? run.createdAt)),
    // How long the run took, from the start of the login until the report was written.
    ...(run.startedAt && { durationSec: Math.max(0, Math.round(((o.finishedAt ?? Date.now()) - new Date(run.startedAt).getTime()) / 1000)) }),
    executionMode: o.fast ? "Fast" : "Standard",
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
        file: ref(file),
        caption: (s.notes ?? `Step ${s.label ?? s.index}: ${s.description}`).slice(0, 120),
      }] as const)).reverse()).values(),
    ].reverse().concat(
      (o.otherScreenshots ?? [])
        .filter((file) => !run.steps.some((s) => s.screenshots.includes(file)))
        .sort()
        .map((file) => ({ file: ref(file), caption: file.replace(/\.(png|jpe?g)$/i, "").replace(/^\d+_/, "").replace(/_/g, " ") })),
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
    for (const leftover of await readdir(join(runsDir, entry.name)).catch(() => [] as string[])) {
      if (!/^(persona-state(-\d+)?\.json|mcp\.json|mcp-output(-\d+)?)$/.test(leftover)) continue;
      await rm(join(runsDir, entry.name, leftover), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}