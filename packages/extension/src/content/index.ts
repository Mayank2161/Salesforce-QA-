import { personaLabel, type Org, type Persona, type Run, type RunEvent, type SalesforceUser, type StepResult } from "@sfqa/shared";
import { RUN_EVENTS_PORT, send, type Connection, type PortMessage } from "../messages.ts";
import { h, logo } from "./dom.ts";
import { createProjectsPanel } from "./projects.ts";
import { createStoryPanel } from "./story.ts";
import { createSuitePanel } from "./suite.ts";
import { STYLES } from "./styles.ts";

const ROOT_ID = "sfqa-agent-root";
const CONNECT_POLL_MS = 3000;
const SEARCH_DEBOUNCE_MS = 300;
const RESULT_POLL_MS = 4000;

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
const addPersonaButton = h("button", { className: "btn link", title: "Add a persona", textContent: "+ Add persona" });
const removePersonaButton = h("button", { className: "btn link danger", title: "Remove this persona", textContent: "Remove" });
const personaHint = h("div", { className: "hint" });

// Add persona: pick the Salesforce user it runs as, then name it.
const userSearch = h("input", { placeholder: "Search users by name or username" });
const userResults = h("div", { className: "user-results" });
const newPersonaName = h("input", { placeholder: "e.g. Sales, Sales Manager" });
const addPersonaError = h("div", { className: "hint warn" });
const addPersonaSubmit = h("button", { className: "btn small", textContent: "Add persona", disabled: true });
let pickedUser: SalesforceUser | undefined;
const step = (n: string, title: string, hint: string) => h("div", { className: "step-head" },
  h("span", { className: "step-num", textContent: n }),
  h("div", {}, h("div", { className: "step-name", textContent: title }), h("div", { className: "hint", textContent: hint })),
);
const addPersonaForm = h("div", { className: "subform", hidden: true },
  h("div", { className: "subform-title", textContent: "New persona" }),
  step("1", "Choose the Salesforce user", "Tests log in as this user with Login As."),
  userSearch,
  userResults,
  step("2", "Name the persona", "Several users can share a name, for example two Sales users."),
  newPersonaName,
  addPersonaError,
  h("div", { className: "row end" },
    h("button", { className: "btn secondary", textContent: "Cancel", onclick: () => toggleAddPersona(false) }),
    addPersonaSubmit,
  ),
);

// Other personas a single test needs (for example the manager who approves). Each gets its own browser.
const extraPersonasBox = h("div", { className: "extra-personas" });
const extraPersonasField = h("div", { className: "field", hidden: true },
  h("div", { className: "field-label", textContent: "Also involves (optional)" }),
  extraPersonasBox,
  h("div", { className: "hint", textContent: "Tick the other users this test needs, for example a manager who approves. Each runs in its own browser, logged in as that user." }),
);
const selectedExtraPersonas = (): string[] =>
  [...extraPersonasBox.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value).filter((id) => id !== personaSelect.value);

const titleInput = h("input", { placeholder: "e.g. Sales manager can close an opportunity" });
const bodyInput = h("textarea", { placeholder: "Paste the test case: steps and expected results" });
const runButton = h("button", { className: "btn primary block", textContent: "Run test" });
// Clears the previous test case and its result so the next one can be pasted.
const newTestButton = h("button", { className: "btn secondary new-test", textContent: "New test case", title: "Clear this test case and its result", hidden: true });
const result = h("div", { className: "result", hidden: true });

// Single pasted test case (unchanged) or a batch uploaded from Excel/CSV.
const singleBox = h("div", { className: "mode-box" },
  extraPersonasField,
  h("label", {}, "Title (optional)", titleInput),
  h("label", {}, "Test case", bodyInput),
  h("div", { className: "row run-row" }, runButton, newTestButton),
  result,
);
// Project folders: where this panel's runs save their reports, plus notes for the project and org.
const projectsPanel = createProjectsPanel({
  orgId: () => orgSelect.value,
  orgName: () => currentOrg()?.name,
});

const suitePanel = createSuitePanel({
  orgId: () => orgSelect.value,
  project: () => projectsPanel.project(),
  fast: () => fastToggle.checked,
  personas: () => currentOrg()?.personas ?? [],
  defaultPersona: () => currentPersona(),
  canRun: () => {
    const c = currentConnection();
    return agentConnected && Boolean(c?.connected) && !c?.expired;
  },
});
const suiteBox = h("div", { className: "mode-box", hidden: true }, suitePanel.element);
const singleTab = h("button", { className: "tab active", textContent: "Single test", type: "button" });
const suiteTab = h("button", { className: "tab", textContent: "Upload file", title: "Run test cases from an Excel or CSV file", type: "button" });
const storyTab = h("button", { className: "tab", textContent: "Jira story", type: "button" });
const modeTabs = h("div", { className: "tabs" }, singleTab, suiteTab, storyTab);

// Paste a Jira story, generate test cases, review them, and run the approved ones as a batch.
const storyPanel = createStoryPanel({
  orgId: () => orgSelect.value,
  orgName: () => currentOrg()?.name,
  project: () => projectsPanel.project(),
  personas: () => currentOrg()?.personas ?? [],
  defaultPersona: () => currentPersona(),
  fast: () => fastToggle.checked,
  canRun: () => {
    const c = currentConnection();
    return agentConnected && Boolean(c?.connected) && !c?.expired;
  },
  onBatchStarted: (suiteId, scope) => {
    setMode("suite");
    void suitePanel.showSuite(suiteId, scope);
  },
});
const storyBox = h("div", { className: "mode-box", hidden: true }, storyPanel.element);

// Fast execution on/off for the runs started from this panel (single test and batches). Off runs
// exactly the current way; on starts Claude during the login and lets it record several steps at once.
const fastToggle = h("input", { type: "checkbox", className: "switch-input" });
const fastState = h("span", { className: "switch-state" });
const fastHint = h("div", { className: "hint" });
const fastRow = h("div", { className: "fast-row" },
  h("label", { className: "switch" }, fastToggle, h("span", { className: "switch-track" }, h("span", { className: "switch-knob" })), h("span", { className: "switch-label", textContent: "Fast execution" }), fastState),
  fastHint,
);
function renderFast(): void {
  fastState.textContent = fastToggle.checked ? "On" : "Off";
  fastState.className = `switch-state${fastToggle.checked ? " on" : ""}`;
  fastHint.textContent = fastToggle.checked
    ? "On: Claude starts during the login and records finished steps together. Same checks, screenshots and PASS/FAIL rules."
    : "Off: runs work exactly as before (current mode).";
}
// Clicking the switch must not move the panel: keep the scroll position as it was.
fastRow.addEventListener("mousedown", () => {
  const body = panel.querySelector<HTMLElement>(".body");
  const top = body?.scrollTop ?? 0;
  requestAnimationFrame(() => { if (body) body.scrollTop = top; panel.scrollTop = 0; });
});
fastToggle.onchange = () => {
  renderFast();
  void chrome.storage.local.set({ fastExecution: fastToggle.checked });
};

function setMode(mode: "single" | "suite" | "story"): void {
  singleTab.classList.toggle("active", mode === "single");
  suiteTab.classList.toggle("active", mode === "suite");
  storyTab.classList.toggle("active", mode === "story");
  singleBox.hidden = mode !== "single";
  suiteBox.hidden = mode !== "suite";
  storyBox.hidden = mode !== "story";
  // The batch table and the generated test cases need more room than a single test.
  panel.classList.toggle("wide", mode !== "single");
  if (mode === "suite") suitePanel.refresh();
  if (mode === "story") storyPanel.refresh();
  void chrome.storage.local.set({ panelMode: mode });
}
singleTab.onclick = () => setMode("single");
suiteTab.onclick = () => setMode("suite");
storyTab.onclick = () => setMode("story");

const section = (title: string, ...children: (Node | string)[]) =>
  h("section", { className: "card" }, h("div", { className: "card-title", textContent: title }), ...children);

const panel = h("div", { className: "panel", hidden: true },
  h("div", { className: "header" },
    logo("header-logo"),
    h("div", { className: "title" },
      h("h1", { textContent: "Salesforce QA Agent" }),
      h("div", { className: "subtitle", textContent: "AI-driven testing in your org" }),
    ),
    h("button", { className: "icon-btn", title: "Reload orgs and personas", textContent: "↻", onclick: () => void refresh() }),
    h("button", { className: "icon-btn", title: "Close", textContent: "✕", onclick: () => { panel.hidden = true; } }),
  ),
  h("div", { className: "body" },
    conn,
    section("Environment",
      h("label", {}, "Org", orgSelect, orgHint),
      orgConnRow,
    ),
    projectsPanel.element,
    section("Run as",
      h("label", {}, "Persona", personaSelect),
      personaHint,
      h("div", { className: "row" }, addPersonaButton, removePersonaButton),
      addPersonaForm,
    ),
    h("section", { className: "card" },
      fastRow,
      modeTabs,
      singleBox,
      suiteBox,
      storyBox,
    ),
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

    const saved = await chrome.storage.local.get(["lastOrgId", "lastPersonaId", "panelMode", "fastExecution"]);
    fastToggle.checked = saved.fastExecution === true;
    renderFast();
    if (saved.panelMode === "suite" || saved.panelMode === "story") setMode(saved.panelMode);
    orgSelect.value = detectedOrgId ?? (saved.lastOrgId as string | undefined) ?? orgs[0]?.id ?? "";
    renderOrgHint(detected?.created ?? false);
    renderOrg(saved.lastPersonaId as string | undefined);
    void projectsPanel.refresh();

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
  renderExtraPersonas();
  renderPersonaHint();
}

// Checkboxes for the other personas of the org; the selected main persona is never offered.
function renderExtraPersonas(): void {
  const keep = new Set(selectedExtraPersonas());
  const others = (currentOrg()?.personas ?? []).filter((p) => p.id !== personaSelect.value);
  extraPersonasField.hidden = others.length === 0;
  extraPersonasBox.replaceChildren(...others.map((p) => {
    const box = h("input", { type: "checkbox", value: p.id, checked: keep.has(p.id) });
    box.onchange = () => {
      // At most 3 other personas (4 browsers in total).
      if (selectedExtraPersonas().length > 3) box.checked = false;
    };
    return h("label", { className: "chip", title: p.userFullName ?? p.name }, box, h("span", { textContent: personaLabel(p, currentOrg()?.personas ?? []) }));
  }));
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
  updateNewTestButton();
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
    addPersonaError.textContent = message === "persona_exists"
      ? `${pickedUser.name} is already set up as "${name}". Pick another user or use a different name.`
      : message;
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
  // The project's folder for the newly selected org (created on first use).
  void projectsPanel.refresh();
};
personaSelect.onchange = () => {
  renderExtraPersonas();
  renderPersonaHint();
};
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
  newTestButton.hidden = true;
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
    const extraPersonaIds = selectedExtraPersonas();
    const project = projectsPanel.project();
    const run = await send({ type: "createRun", request: { orgId, personaId, ...(extraPersonaIds.length && { extraPersonaIds }), testCase: { body, ...(title && { title }) }, ...(project && { project }), fast: fastToggle.checked } });
    watchRun(run.id);
  } catch (err) {
    result.replaceChildren(h("div", { className: "error-box", textContent: (err as Error).message }));
    updateRunButton();
  }
}
runButton.onclick = () => void startRun();

// Offered once there is something to clear, and never while a run is still in progress.
function updateNewTestButton(): void {
  const hasContent = Boolean(titleInput.value.trim() || bodyInput.value.trim()) || !result.hidden;
  newTestButton.hidden = !hasContent || pendingRunId !== undefined;
}

function newTestCase(): void {
  if (pendingRunId !== undefined) return;
  runPort?.disconnect();
  runPort = undefined;
  clearInterval(queueTimer);
  clearInterval(resultPoll);
  titleInput.value = "";
  bodyInput.value = "";
  for (const box of [...extraPersonasBox.querySelectorAll<HTMLInputElement>("input:checked")]) box.checked = false;
  result.replaceChildren();
  result.hidden = true;
  updateRunButton();
  bodyInput.focus();
}
newTestButton.onclick = newTestCase;
titleInput.oninput = updateNewTestButton;
bodyInput.oninput = updateNewTestButton;

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

// The run whose result is still to be shown; cleared once the final record has been rendered.
let pendingRunId: string | undefined;
let resultPoll: ReturnType<typeof setInterval> | undefined;

function watchRun(runId: string): void {
  watchQueue(runId);
  pendingRunId = runId;
  updateNewTestButton();
  clearInterval(resultPoll);
  const port = chrome.runtime.connect({ name: RUN_EVENTS_PORT });
  runPort = port;
  port.onMessage.addListener((msg: PortMessage) => {
    if (msg.kind === "error") return; // the poll below takes over if the connection is gone
    onEvent(runId, msg.event);
  });
  port.onDisconnect.addListener(() => {
    if (runPort !== port) return;
    // Chrome can suspend the background worker mid-run, which drops the live connection. Keep
    // asking the server until the run is finished, so the result and report links always appear.
    if (pendingRunId === runId) pollForResult(runId);
    else updateRunButton();
  });
  port.postMessage({ runId });
}

function pollForResult(runId: string): void {
  clearInterval(resultPoll);
  resultPoll = setInterval(async () => {
    if (pendingRunId !== runId) return clearInterval(resultPoll);
    const run = await send({ type: "getRun", runId }).catch(() => undefined);
    if (!run) return;
    if (run.status === "completed" || run.status === "error") finishRun(runId, run);
    else {
      // Show steps that arrived while the connection was down.
      setStatus(run.status);
      if (run.steps.length !== stepsBox.childElementCount) stepsBox.replaceChildren(...run.steps.map((s) => renderStep(runId, s)));
    }
  }, RESULT_POLL_MS);
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
  if (pendingRunId === runId) pendingRunId = undefined;
  clearInterval(resultPoll);
  setStatus(run.status, run.verdict);
  if (run.displayId) runIdText.textContent = run.displayId;
  // Re-render from the final record so a page that connected late still shows every step and bug.
  stepsBox.replaceChildren(...run.steps.map((s) => renderStep(runId, s)));
  bugsBox.replaceChildren();
  for (const bug of run.bugs) addBug(bug);
  if (run.summary) addLog("info", `Result: ${run.summary}`);
  if (run.error) addLog("error", run.error);
  if (run.displayId) void showReportLinks(run);
  else linksBox.replaceChildren(newTestLink());
  updateRunButton();
}

function addBug(bug: Run["bugs"][number]): void {
  if (!bugsBox.firstChild) bugsBox.append(h("div", { className: "bugs-title", textContent: "Bugs" }));
  bugsBox.append(h("div", { className: "bug-line" },
    h("span", { className: `badge sev-${bug.severity}`, textContent: bug.severity }),
    h("span", { textContent: `${bug.id}${bug.reproduced ? " (reproduced)" : ""}: ${bug.title}` }),
  ));
}

// Same action as the button under the test case, placed where the finished result ends.
const newTestLink = () => h("button", { className: "btn link links-new", textContent: "+ New test case", onclick: newTestCase });

async function showReportLinks(run: Run): Promise<void> {
  try {
    // The reports this run was saved in: its project's org folder, or the shared reports for its org.
    const links = await send({ type: "getReportLinks", orgId: run.request.orgId, ...(run.reports && { project: run.reports.project }) });
    linksBox.replaceChildren(
      newTestLink(),
      ...(run.bugs.length
        ? [h("button", { className: "btn secondary", textContent: `Bug report (${run.bugs.length})`, onclick: () => window.open(`${links.bugReport}#${run.bugs[0]!.id}`, "_blank") })]
        : []),
      h("button", { className: "btn small", textContent: "Open test report", onclick: () => window.open(`${links.executionReport}#${run.displayId}`, "_blank") }),
    );
  } catch {
    // Reports are optional; the panel still shows the full result.
    linksBox.replaceChildren(newTestLink());
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
  for (const file of step.screenshots.filter((f) => f.endsWith(".json"))) box.append(renderApiEvidence(runId, file));
  for (const file of step.screenshots.filter((f) => !f.endsWith(".json"))) {
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

// An API check recorded by call_api: method, path and status, with the response on demand.
function renderApiEvidence(runId: string, file: string): HTMLElement {
  const head = h("summary", { textContent: `API call (${file})` });
  const body = h("pre", { className: "api-body" });
  const box = h("details", { className: "api-evidence" }, head, body);
  send({ type: "getEvidence", runId, file }).then(({ dataUrl }) => {
    const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const e = JSON.parse(new TextDecoder().decode(bytes)) as {
      purpose?: string; target?: string; request: { method: string; url: string }; response: { status: number; statusText?: string; body: unknown };
    };
    const url = new URL(e.request.url);
    head.textContent = `API ${e.request.method} ${url.pathname} → ${e.response.status}${e.purpose ? ` · ${e.purpose}` : ""}`;
    head.className = e.response.status >= 200 && e.response.status < 300 ? "ok" : "bad";
    const text = typeof e.response.body === "string" ? e.response.body : JSON.stringify(e.response.body, null, 2);
    body.textContent = `${e.target ?? ""} ${e.request.method} ${url.pathname}${url.search}\n\n${text.length > 3000 ? `${text.slice(0, 3000)}\n…` : text}`;
  }, (err: Error) => { head.textContent = `API evidence unavailable: ${err.message}`; });
  return box;
}

function addLog(level: "info" | "warn" | "error", message: string): void {
  logBox.append(h("div", { className: level, textContent: `${new Date().toLocaleTimeString()}  ${message}` }));
  logBox.scrollTop = logBox.scrollHeight;
}

mount();
