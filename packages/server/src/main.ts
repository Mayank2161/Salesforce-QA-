import { AgentBridge } from "./agent/bridge.ts";
import { claudeSettingsFromEnv } from "./agent/claude.ts";
import { buildApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { APIS_CONFIG_PATH, AUTH_DIR, BROWSER_MCP_SCRIPT, REPO_ROOT, ORGS_CONFIG_PATH, PLAYWRIGHT_MCP_CLI, QA_DIR, QA_MCP_SCRIPT, QA_TEMPLATES_DIR, REVIEW_MCP_SCRIPT, RUNS_DIR } from "./paths.ts";
import { QaWorkspace } from "./reports/workspace.ts";
import { ProjectStore } from "./projects/store.ts";
import { openFolder, workspaceRoot } from "./projects/workspace-root.ts";
import { ReviewService } from "./reviews/service.ts";
import { RunStore } from "./runs/store.ts";
import { cleanupStaleRuns, createRunner } from "./runs/runner.ts";
import { SalesforceApiError, adminApi, searchUsers } from "./salesforce/api.ts";
import { browserSettingsFromEnv } from "./salesforce/browser.ts";
import { connectOrg } from "./salesforce/login.ts";

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const store = new RunStore();
const browser = browserSettingsFromEnv();
const bridge = new AgentBridge();
// Run ids are unique across qa/ and every project folder.
const qa = new QaWorkspace(QA_DIR, QA_TEMPLATES_DIR, undefined, { otherRunIds: () => projects.runIds() });
await qa.ensure();
// Project folders for reports and notes (QA_WORKSPACE_DIR, default QA-Workspace/ in the repository).
let projects: ProjectStore;
try {
  projects = new ProjectStore(workspaceRoot(process.env.QA_WORKSPACE_DIR, REPO_ROOT), QA_TEMPLATES_DIR, { sharedRunsDir: qa.screenshotsDir("") });
  await projects.ensure();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
console.log(`Project folders: ${projects.root}`);
const cleaned = await cleanupStaleRuns(RUNS_DIR);
if (cleaned) console.log(`Removed ${cleaned} leftover file(s) from runs interrupted by a previous shutdown.`);

const paths = { orgsConfigPath: ORGS_CONFIG_PATH, authDir: AUTH_DIR, runsDir: RUNS_DIR };
const claude = claudeSettingsFromEnv();
const serverUrl = `http://127.0.0.1:${env.PORT}`;
const runRun = createRunner({
  store,
  ...paths,
  browser,
  agent: {
    bridge,
    qa,
    claude,
    serverUrl,
    qaMcpScript: QA_MCP_SCRIPT,
    playwrightMcpCli: PLAYWRIGHT_MCP_CLI,
    projects,
    // HYBRID_EXECUTION=false runs every browser action through Claude, as before.
    hybrid: process.env.HYBRID_EXECUTION !== "false",
    browserMcpScript: BROWSER_MCP_SCRIPT,
    apisConfigPath: APIS_CONFIG_PATH,
  },
});
const reviews = new ReviewService({ bridge, qa, claude, serverUrl, reviewMcpScript: REVIEW_MCP_SCRIPT, workDir: RUNS_DIR });

const app = await buildApp({
  token: env.AGENT_TOKEN,
  ...paths,
  store,
  bridge,
  qa,
  projects,
  openFolder,
  reviews,
  onRunCreated: runRun,
  connectOrg: async (org) => {
    await connectOrg({ org, authDir: AUTH_DIR, browser });
  },
  searchUsers: async (org, term) => searchUsers(await adminApi(AUTH_DIR, org), term),
  // Only a definite "session expired" counts; network trouble is not reported as expiry.
  verifyConnection: (org) => adminApi(AUTH_DIR, org).then((api) => api.whoAmI()).then(
    () => true,
    (err) => !(err instanceof SalesforceApiError && err.code === "session_expired"),
  ),
});
// Loopback only: the server must never be reachable from the network.
await app.listen({ host: "127.0.0.1", port: env.PORT });
