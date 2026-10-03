import type { Org, Persona, Run, RunEvent, SalesforceUser, StepResult } from "@sfqa/shared";
import { RUN_EVENTS_PORT, send, type Connection, type PortMessage } from "../messages.ts";
import { h, logo } from "./dom.ts";
import { createSuitePanel } from "./suite.ts";
import { STYLES } from "./styles.ts";

const ROOT_ID = "sfqa-agent-root";
const CONNECT_POLL_MS = 3000;
const SEARCH_DEBOUNCE_MS = 300;

let orgs: Org[] = [];
let connections: Connection[] = [];
let detectedOrgId: string | undefined;
let runPort: chrome.runtime.Port | undefined;
let connectPoll: ReturnType<typeof setInterval> | undefined;

// --- DOM ---------------------------------------------------------------------

const conn = h("div", { className: "conn" });
const orgSelect = h("select");
const orgHint = h("span", { className: "hint" });
const orgConnRow = h("div", { className: "login-row" });
const personaSelect = h("select");
const addPersonaButton = h("button", { className: "btn secondary", title: "Add a persona", textContent: "+ Add" });
const removePersonaButton = h("button", { className: "btn secondary", title: "Remove this persona", textContent: "Remove" });
const personaHint = h("div", { className: "hint" });

// Add persona: pick the Salesforce user it runs as, then name it.
const userSearch = h("input", { placeholder: "Search users by name or username" });
const userResults = h("div", { className: "user-results" });
const newPersonaName = h("input", { placeholder: "Persona name, e.g. Sales Manager" });
const addPersonaError = h("div", { className: "hint warn" });
const addPersonaSubmit = h("button", { className: "btn small", textContent: "Add persona", disabled: true });
let pickedUser: SalesforceUser | undefined;
const addPersonaForm = h("div", { className: "subform", hidden: true },
  h("div", { className: "hint", textContent: "Pick the Salesforce user this persona runs as. Tests log in as them with Login As." }),
  userSearch,
  userResults,
  newPersonaName,
  addPersonaError,
  h("div", { className: "row end" },
    h("button", { className: "btn secondary", textContent: "Cancel", onclick: () => toggleAddPersona(false) }),
    addPersonaSubmit,
  ),
);

const titleInput = h("input", { placeholder: "e.g. Sales manager can close an opportunity" });
const bodyInput = h("textarea", { placeholder: "Paste the test case: steps and expected results" });
const runButton = h("button", { className: "btn", textContent: "Run test" });
const result = h("div", { className: "result", hidden: true });

// Single pasted test case (unchanged) or a batch uploaded from Excel/CSV.
const singleBox = h("div", { className: "mode-box" },
  h("label", {}, "Title (optional)", titleInput),
  h("label", {}, "Test case", bodyInput),
  runButton,
  result,
);
const suitePanel = createSuitePanel({
  orgId: () => orgSelect.value,
  personas: () => currentOrg()?.personas ?? [],
  defaultPersona: () => currentPersona(),
  canRun: () => {
    const c = currentConnection();
    return agentConnected && Boolean(c?.connected) && !c?.expired;
  },
});
const suiteBox = h("div", { className: "mode-box", hidden: true }, suitePanel.element);
const singleTab = h("button", { className: "tab active", textContent: "Single test", type: "button" });
const suiteTab = h("button", { className: "tab", textContent: "Upload file (Excel / CSV)", type: "button" });
const modeTabs = h("div", { className: "tabs" }, singleTab, suiteTab);

function setMode(mode: "single" | "suite"): void {
  singleTab.classList.toggle("active", mode === "single");
  suiteTab.classList.toggle("active", mode === "suite");
  singleBox.hidden = mode !== "single";
  suiteBox.hidden = mode !== "suite";
  // The batch table needs more room than a single test.
  panel.classList.toggle("wide", mode === "suite");
  if (mode === "suite") suitePanel.refresh();
  void chrome.storage.local.set({ panelMode: mode });
}
singleTab.onclick = () => setMode("single");
suiteTab.onclick = () => setMode("suite");

const panel = h("div", { className: "panel", hidden: true },
  h("div", { className: "header" },
    logo("header-logo"),
    h("h1", { textContent: "Salesforce QA Agent" }),
    h("button", { className: "icon-btn", title: "Reload orgs and personas", textContent: "↻", onclick: () => void refresh() }),
    h("button", { className: "icon-btn", title: "Close", textContent: "✕", onclick: () => { panel.hidden = true; } }),
  ),
  h("div", { className: "body" },
    conn,
    h("label", {}, "Org", orgSelect, orgHint),
    orgConnRow,
    h("label", {}, "Persona", h("div", { className: "row" }, personaSelect, addPersonaButton, removePersonaButton)),
    personaHint,
    addPersonaForm,
    modeTabs,
    singleBox,
    suiteBox,
  ),
);

const fab = h("button", { className: "fab", title: "Salesforce QA Agent" }, logo("fab-logo"));
fab.onclick = () => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden && orgs.length === 0) void refresh();
};

function mount(): void {
  if (window.top !== window || document.getElementById(ROOT_ID)) return;
  const host = h("div", { id: ROOT_ID });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(h("style", { textContent: STYLES }), fab, panel);
  document.documentElement.append(host);
}

// --- Agent connection and org detection ----------------------------------------

let agentConnected = false;

function setAgentStatus(state: "pending" | "ok" | "err", message: string): void {
  agentConnected = state === "ok";
  conn.className = `conn ${state === "pending" ? "" : state}`;
  conn.replaceChildren(h("span", { className: "dot" }), h("span", { textContent: message }));
  if (state === "err") {
    conn.append(h("button", { className: "btn secondary", textContent: "Settings", onclick: () => void send({ type: "openOptions" }) }));
  }
  updateRunButton();
}

async function refresh(): Promise<void> {
  setAgentStatus("pending", "Connecting to agent server…");
  try {
    const { serverUrl } = await send({ type: "status" });
    // Register (or find) the org behind this page before listing, so it is always present.
    const detected = await send({ type: "detectOrg", hostname: location.hostname }).catch(() => undefined);
    detectedOrgId = detected?.org.id;
    await loadOrgs(true);

    const saved = await chrome.storage.local.get(["lastOrgId", "lastPersonaId", "panelMode"]);
    if (saved.panelMode === "suite") setMode("suite");
    orgSelect.value = detectedOrgId ?? (saved.lastOrgId as string | undefined) ?? orgs[0]?.id ?? "";
    renderOrgHint(detected?.created ?? false);
    renderOrg(saved.lastPersonaId as string | undefined);

    setAgentStatus("ok", `Connected to agent (${serverUrl})`);
  } catch (err) {
    setAgentStatus("err", (err as Error).message);
  }
}

// verify: also ask Salesforce whether each saved admin session still works (done when the panel opens).
async function loadOrgs(verify = false): Promise<void> {
  [orgs, connections] = await Promise.all([
    send({ type: "getOrgs" }).then((c) => c.orgs),
    send({ type: "getConnections", verify }).then((c) => c.connections),
  ]);
  const current = orgSelect.value;
  orgSelect.replaceChildren(...orgs.map((o) => h("option", { value: o.id, textContent: o.name })));
  if (orgs.some((o) => o.id === current)) orgSelect.value = current;
}

function renderOrgHint(justCreated: boolean): void {
  if (orgSelect.value && orgSelect.value === detectedOrgId) {
    orgHint.className = "hint ok";
    orgHint.textContent = justCreated ? "New org detected from this page and saved." : "Detected from this page.";
  } else {
    orgHint.className = "hint";
    orgHint.textContent = detectedOrgId ? "Different from the org on this page." : "";
  }
}

const currentOrg = (): Org | undefined => orgs.find((o) => o.id === orgSelect.value);
const currentConnection = (): Connection | undefined => connections.find((c) => c.orgId === orgSelect.value);
const currentPersona = (): Persona | undefined => currentOrg()?.personas.find((p) => p.id === personaSelect.value);

function renderOrg(preferredPersonaId?: string): void {
  renderConnection();
  renderPersonas(preferredPersonaId);
}

// The org admin connects once; every persona then runs via Login As from that session.
function renderConnection(): void {
  const org = currentOrg();
  const c = currentConnection();
  if (!org) {
    orgConnRow.replaceChildren();
  } else if (c?.connectInProgress) {
    orgConnRow.replaceChildren(h("span", { className: "hint warn", textContent: "An admin login window is open on your desktop. Log in there once…" }));
  } else if (c?.connected && c.expired) {
    orgConnRow.replaceChildren(
      h("span", { className: "hint warn", textContent: "The saved admin session has expired (Salesforce timed it out). Reconnect once to continue." }),
      h("button", { className: "btn small", textContent: "Reconnect", onclick: () => void connectOrg() }),
    );
  } else if (c?.connected) {
    orgConnRow.replaceChildren(
      h("span", { className: "hint ok", textContent: `Org connected${c.name ? ` as ${c.name}` : ""} (${new Date(c.savedAt!).toLocaleString()})` }),
      h("button", { className: "btn secondary", textContent: "Reconnect", onclick: () => void connectOrg() }),
    );
  } else {
    orgConnRow.replaceChildren(
      h("span", { className: "hint warn", textContent: "Not connected. Log in once as an admin who can use Login As." }),
      h("button", { className: "btn small", textContent: "Connect org", onclick: () => void connectOrg() }),
    );
  }
  addPersonaButton.disabled = !c?.connected;
  renderPersonaHint();
}

async function connectOrg(): Promise<void> {
  const orgId = orgSelect.value;
  try {
    await send({ type: "connectOrg", orgId });
  } catch (err) {
    if ((err as Error).message !== "connect_in_progress") {
      orgConnRow.replaceChildren(h("span", { className: "hint warn", textContent: (err as Error).message }));
      return;
    }
  }
  await pollConnections();
  clearInterval(connectPoll);
  // Stop polling once the login window closes (saved or cancelled), or after 11 minutes.
  const deadline = Date.now() + 11 * 60_000;
  connectPoll = setInterval(async () => {
    await pollConnections();
    const c = connections.find((x) => x.orgId === orgId);
    if (!c?.connectInProgress || Date.now() > deadline) clearInterval(connectPoll);
  }, CONNECT_POLL_MS);
}

async function pollConnections(): Promise<void> {
  connections = (await send({ type: "getConnections" }).catch(() => ({ connections }))).connections;
  renderConnection();
}

function renderPersonas(preferredId?: string): void {
  const personas = currentOrg()?.personas ?? [];
  const previous = preferredId ?? personaSelect.value;

  if (personas.length === 0) {
    personaSelect.replaceChildren(h("option", { value: "", textContent: "No personas yet" }));
    personaSelect.disabled = true;
  } else {
    personaSelect.disabled = false;
    personaSelect.replaceChildren(...personas.map((p) =>
      h("option", { value: p.id, textContent: p.userFullName ? `${p.name} — ${p.userFullName}` : p.name })));
    if (personas.some((p) => p.id === previous)) personaSelect.value = previous;
  }
  removePersonaButton.hidden = personas.length === 0;
  renderPersonaHint();
}

function renderPersonaHint(): void {
  const p = currentPersona();
  if (p) {
    personaHint.className = "hint";
    const who = [p.userFullName, p.username && `(${p.username})`, p.profile && `· ${p.profile}`].filter(Boolean).join(" ");
    personaHint.textContent = `Runs as ${who || "an unlinked user"} via Login As.`;
  } else {
    personaHint.className = "hint";
    personaHint.textContent = currentConnection()?.connected
      ? "Add the users you test as, for example Sales User or Sales Manager."
      : "Connect the org first, then add personas.";
  }
  updateRunButton();
}

function updateRunButton(): void {
  const c = currentConnection();
  runButton.disabled = !agentConnected || !c?.connected || Boolean(c.expired) || !currentPersona();
  // Persona, org and connection also decide what the batch view can run.
  if (!suiteBox.hidden) suitePanel.refresh();
}

// --- Adding personas -----------------------------------------------------------

function toggleAddPersona(show: boolean): void {
  addPersonaForm.hidden = !show;
  addPersonaError.textContent = "";
  if (!show) return;
  pickedUser = undefined;
  userSearch.value = "";
  newPersonaName.value = "";
  addPersonaSubmit.disabled = true;
  userSearch.focus();
  void searchUsers();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;
userSearch.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void searchUsers(), SEARCH_DEBOUNCE_MS);
};

async function searchUsers(): Promise<void> {
  const seq = ++searchSeq;
  userResults.replaceChildren(h("div", { className: "hint", textContent: "Searching…" }));
  try {
    const { users } = await send({ type: "searchUsers", orgId: orgSelect.value, q: userSearch.value.trim() });
    if (seq !== searchSeq) return; // a newer search is in flight
    if (users.length === 0) {
      userResults.replaceChildren(h("div", { className: "hint", textContent: "No active users match." }));
      return;
    }
    userResults.replaceChildren(...users.map((u) => {
      const row = h("button", { className: "user-row", type: "button" },
        h("span", { className: "user-name", textContent: u.name }),
        h("span", { className: "user-meta", textContent: [u.username, u.profile].filter(Boolean).join(" · ") }),
      );
      row.onclick = () => pickUser(u, row);
      return row;
    }));
  } catch (err) {
    if (seq === searchSeq) userResults.replaceChildren(h("div", { className: "hint warn", textContent: (err as Error).message }));
  }
}

function pickUser(user: SalesforceUser, row: HTMLElement): void {
  pickedUser = user;
  for (const el of userResults.querySelectorAll(".user-row")) el.classList.toggle("picked", el === row);
  // Default the persona name to the user's profile, e.g. "RMS Sales Manager".
  if (!newPersonaName.value.trim()) newPersonaName.value = user.profile ?? user.name;
  addPersonaSubmit.disabled = false;
  newPersonaName.focus();
}

addPersonaSubmit.onclick = async () => {
  const name = newPersonaName.value.trim();
  if (!pickedUser || !name) return;
  try {
    const persona = await send({
      type: "addPersona",
      orgId: orgSelect.value,
      persona: {
        name,
        username: pickedUser.username,
        userId: pickedUser.id,
        userFullName: pickedUser.name,
        ...(pickedUser.profile && { profile: pickedUser.profile }),
      },
    });
    toggleAddPersona(false);
    await loadOrgs();
    renderPersonas(persona.id);
  } catch (err) {
    const message = (err as Error).message;
    addPersonaError.textContent = message === "persona_exists" ? "A persona with that name already exists." : message;
  }
};

removePersonaButton.onclick = async () => {
  const p = currentPersona();
  if (!p || !confirm(`Remove persona "${p.name}"? The Salesforce user is not changed.`)) return;
  await send({ type: "removePersona", orgId: orgSelect.value, personaId: p.id }).catch(() => undefined);
  await loadOrgs();
  renderPersonas();
};

orgSelect.onchange = () => {
  renderOrgHint(false);
  toggleAddPersona(false);
  renderOrg();
};
personaSelect.onchange = () => renderPersonaHint();
addPersonaButton.onclick = () => toggleAddPersona(addPersonaForm.hidden);

// --- Running a test ----------------------------------------------------------

const statusBadge = h("span", { className: "badge" });
const statusText = h("span");
const runIdText = h("span", { className: "run-id" });
const stepsBox = h("div", { className: "steps" });
const bugsBox = h("div", { className: "bugs" });
const linksBox = h("div", { className: "row end" });
const logBox = h("div", { className: "log" });

async function startRun(): Promise<void> {
  const body = bodyInput.value.trim();
  if (!body) {
    bodyInput.focus();
    return;
  }
  runPort?.disconnect();
  runButton.disabled = true;
  for (const box of [stepsBox, bugsBox, linksBox, logBox]) box.replaceChildren();
  runIdText.textContent = "";
  result.replaceChildren(h("div", { className: "status-line" }, statusBadge, statusText, runIdText), stepsBox, bugsBox, linksBox, logBox);
  result.hidden = false;
  setStatus("queued");

  const orgId = orgSelect.value;
  const personaId = personaSelect.value;
  void chrome.storage.local.set({ lastOrgId: orgId, lastPersonaId: personaId });

  try {
    const title = titleInput.value.trim();
    const run = await send({ type: "createRun", request: { orgId, personaId, testCase: { body, ...(title && { title }) } } });
    watchRun(run.id);
  } catch (err) {
    result.replaceChildren(h("div", { className: "error-box", textContent: (err as Error).message }));
    updateRunButton();
  }
}
runButton.onclick = () => void startRun();

// Runs execute one at a time; while this one waits, show how many are ahead and which is running.
let queueTimer: ReturnType<typeof setInterval> | undefined;

async function showQueuePosition(runId: string): Promise<void> {
  const { runs } = await send({ type: "getRuns" }).catch(() => ({ runs: [] as Run[] }));
  const mine = runs.find((r) => r.id === runId);
  if (!mine || mine.status !== "queued") return;
  const ahead = runs.filter((r) => (r.status === "running" || r.status === "queued") && r.createdAt < mine.createdAt);
  const running = runs.find((r) => r.status === "running");
  statusText.textContent = ahead.length
    ? `Waiting for ${ahead.length} earlier run${ahead.length > 1 ? "s" : ""} to finish${running?.displayId ? ` (${running.displayId} is running)` : ""}. Tests run one at a time.`
    : "Starting…";
}

function watchQueue(runId: string): void {
  clearInterval(queueTimer);
  void showQueuePosition(runId);
  queueTimer = setInterval(() => void showQueuePosition(runId), 5000);
}

function watchRun(runId: string): void {
  watchQueue(runId);
  const port = chrome.runtime.connect({ name: RUN_EVENTS_PORT });
  runPort = port;
  port.onMessage.addListener((msg: PortMessage) => {
    if (msg.kind === "error") addLog("error", msg.error);
    else onEvent(runId, msg.event);
  });
  port.onDisconnect.addListener(() => {
    if (runPort === port) updateRunButton();
  });
  port.postMessage({ runId });
}

function onEvent(runId: string, event: RunEvent): void {
  switch (event.type) {
    case "run.status":
      setStatus(event.status);
      break;
    case "run.step":
      stepsBox.append(renderStep(runId, event.step));
      stepsBox.lastElementChild?.scrollIntoView({ block: "nearest" });
      break;
    case "run.bug":
      addBug(event.bug);
      break;
    case "run.log":
      addLog(event.level, event.message);
      break;
    case "run.completed":
      finishRun(runId, event.run);
      break;
  }
}

function setStatus(status: Run["status"], verdict?: Run["verdict"]): void {
  if (status !== "queued") clearInterval(queueTimer);
  statusBadge.className = `badge ${verdict ?? ""}`;
  statusBadge.textContent = verdict ?? status.toUpperCase();
  statusText.textContent = {
    queued: "Waiting for the runner…",
    running: "Claude is testing in the agent's browser…",
    completed: "Run finished.",
    error: "The agent crashed during this run.",
  }[status];
}

function finishRun(runId: string, run: Run): void {
  setStatus(run.status, run.verdict);
  if (run.displayId) runIdText.textContent = run.displayId;
  // Re-render from the final record so a page that connected late still shows every step and bug.
  stepsBox.replaceChildren(...run.steps.map((s) => renderStep(runId, s)));
  bugsBox.replaceChildren();
  for (const bug of run.bugs) addBug(bug);
  if (run.summary) addLog("info", `Result: ${run.summary}`);
  if (run.error) addLog("error", run.error);
  if (run.displayId) void showReportLinks(run);
  updateRunButton();
}

function addBug(bug: Run["bugs"][number]): void {
  if (!bugsBox.firstChild) bugsBox.append(h("div", { className: "bugs-title", textContent: "Bugs" }));
  bugsBox.append(h("div", { className: "bug-line" },
    h("span", { className: `badge sev-${bug.severity}`, textContent: bug.severity }),
    h("span", { textContent: `${bug.id}${bug.reproduced ? " (reproduced)" : ""}: ${bug.title}` }),
  ));
}

async function showReportLinks(run: Run): Promise<void> {
  try {
    const links = await send({ type: "getReportLinks" });
    linksBox.replaceChildren(
      ...(run.bugs.length
        ? [h("button", { className: "btn secondary", textContent: `Bug report (${run.bugs.length})`, onclick: () => window.open(`${links.bugReport}#${run.bugs[0]!.id}`, "_blank") })]
        : []),
      h("button", { className: "btn small", textContent: "Open test report", onclick: () => window.open(`${links.executionReport}#${run.displayId}`, "_blank") }),
    );
  } catch {
    // Reports are optional; the panel still shows the full result.
  }
}

function renderStep(runId: string, step: StepResult): HTMLElement {
  const box = h("div", { className: "step" },
    h("div", { className: "step-title" },
      h("span", { className: `badge ${step.status.replace("/", "")}`, textContent: step.status }),
      h("span", { textContent: `${step.label ?? step.index}. ${step.description}` }),
    ),
  );
  if (step.actual) box.append(h("div", { className: "actual", textContent: step.actual }));
  for (const file of step.screenshots) {
    const img = h("img", { alt: `Screenshot for step ${step.index + 1}`, title: "Click to enlarge" });
    img.onclick = () => img.classList.toggle("zoomed");
    box.append(img);
    send({ type: "getEvidence", runId, file }).then(
      ({ dataUrl }) => { img.src = dataUrl; },
      (err: Error) => img.replaceWith(h("div", { className: "hint warn", textContent: `Screenshot unavailable: ${err.message}` })),
    );
  }
  return box;
}

function addLog(level: "info" | "warn" | "error", message: string): void {
  logBox.append(h("div", { className: level, textContent: `${new Date().toLocaleTimeString()}  ${message}` }));
  logBox.scrollTop = logBox.scrollHeight;
}

mount();
