import { personaLabel, type ParsedSuite, type Persona, type Suite, type SuiteCase, type SuiteItem } from "@sfqa/shared";
import { send } from "../messages.ts";
import { h } from "./dom.ts";
import { createReviewPanel } from "./review.ts";

// Upload an Excel/CSV of test cases, review the detected rows, then run them one at a time.
// Each row becomes a normal run on the server, so login, execution, screenshots and reports are
// exactly the same as for a single pasted test case.

export interface SuiteContext {
  orgId(): string;
  // Project folder the batch's reports are saved in (none: the shared reports).
  project(): string | undefined;
  personas(): Persona[];
  // The persona selected in the main Persona dropdown; used for rows without a matching persona.
  defaultPersona(): Persona | undefined;
  // Agent server reachable and the org's admin session valid.
  canRun(): boolean;
}

const POLL_MS = 3000;
const MAX_BYTES = 5 * 1024 * 1024;
const LAST_SUITE_KEY = "lastSuiteId";

export function createSuitePanel(ctx: SuiteContext): { element: HTMLElement; refresh(): void } {
  let parsed: ParsedSuite | undefined;
  let suite: Suite | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const selected = new Set<number>(); // spreadsheet row numbers
  let batchScope: { orgId: string; project?: string } | undefined;

  const fileInput = h("input", { type: "file", accept: ".xlsx,.csv", hidden: true });
  const drop = h("div", { className: "drop", tabIndex: 0 },
    h("div", { className: "drop-title", textContent: "\u{1F4C1} Upload Excel / CSV" }),
    h("div", { className: "hint", textContent: "Drop a .xlsx or .csv file here, or click to choose. Columns: TC ID, Title, Steps, Expected Result (plus Module, Persona, Pre-Req, ...). For a test with several users, list them in the Persona cell: \"Sales, Sales Manager\"." }),
    fileInput,
  );
  const message = h("div", { className: "suite-msg" });
  const table = h("div", { className: "suite-table" });
  const personaNote = h("div", { className: "hint" });
  const buttons = h("div", { className: "row end suite-actions" });
  const summary = h("div", { className: "suite-summary", hidden: true });
  // Optional: check the selected rows against a BRD / requirement sheet before (or instead of) running them.
  const review = createReviewPanel({
    orgId: () => ctx.orgId(),
    cases: () => parsed?.cases.filter((c) => !c.error && c.tcId && selected.has(c.row)) ?? [],
    testCasesFileName: () => parsed?.fileName,
  });
  review.element.hidden = true;
  const element = h("div", { className: "suite" }, drop, message, personaNote, table, buttons, review.element, summary);

  // --- Choosing a file ----------------------------------------------------------

  drop.onclick = () => fileInput.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); };
  fileInput.onchange = () => { if (fileInput.files?.[0]) void load(fileInput.files[0]); fileInput.value = ""; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) void load(file);
  };

  async function load(file: File): Promise<void> {
    if (isActive()) return showMessage("warn", "A batch is still running. Stop it or wait for it to finish first.");
    forgetSuite();
    parsed = undefined;
    review.element.hidden = true;
    table.replaceChildren();
    buttons.replaceChildren();
    if (!/\.(xlsx|csv)$/i.test(file.name)) return showMessage("err", `"${file.name}" is not an Excel .xlsx or .csv file.`);
    if (file.size > MAX_BYTES) return showMessage("err", "The file is larger than 5 MB.");
    showMessage("", `Reading ${file.name}…`);
    try {
      parsed = await send({ type: "parseSuite", orgId: ctx.orgId(), fileName: file.name, data: toBase64(await file.arrayBuffer()) });
    } catch (err) {
      return showMessage("err", (err as Error).message);
    }
    if (parsed.missingColumns.length) {
      const found = parsed.columns.length ? ` Columns found: ${parsed.columns.join(", ")}.` : "";
      showMessage("err", `Missing required column${parsed.missingColumns.length > 1 ? "s" : ""}: ${parsed.missingColumns.join(", ")}. Nothing will run.${found}`);
      parsed = undefined;
      return;
    }
    selected.clear();
    for (const c of parsed.cases) if (!c.error) selected.add(c.row);
    renderReview();
  }

  // --- Review before running -----------------------------------------------------

  function renderReview(): void {
    if (!parsed) return;
    const valid = parsed.cases.filter((c) => !c.error);
    const invalid = parsed.cases.length - valid.length;
    showMessage(valid.length ? "ok" : "err",
      `${valid.length} test case${valid.length === 1 ? "" : "s"} detected` +
      `${invalid ? ` (${invalid} invalid row${invalid > 1 ? "s" : ""} will not run)` : ""}` +
      ` in ${parsed.fileName}${parsed.sheet ? `, sheet "${parsed.sheet}"` : ""}.`);

    const all = h("input", { type: "checkbox", title: "Select all", checked: valid.length > 0 && valid.every((c) => selected.has(c.row)) });
    all.onchange = () => {
      for (const c of valid) toggle(c.row, all.checked);
      renderReview();
    };
    table.replaceChildren(headerRow(all), ...parsed.cases.map(reviewRow));
    renderPersonaNote();
    renderReviewButtons();
    review.element.hidden = false;
    review.update();
  }

  function reviewRow(c: SuiteCase): HTMLElement {
    const box = h("input", { type: "checkbox", checked: selected.has(c.row), disabled: Boolean(c.error) });
    box.onchange = () => {
      toggle(c.row, box.checked);
      renderReview();
    };
    const persona = personaFor(c);
    return h("div", { className: `srow${c.error ? " invalid" : ""}`, title: c.error ?? c.warning ?? "" },
      box,
      h("span", { className: "tc", textContent: c.tcId ?? `(row ${c.row})` }),
      h("span", { className: "mod", textContent: c.module ?? "" }),
      h("span", { className: "ttl", textContent: c.title }),
      h("span", { className: `per${!c.error && !c.personaId ? " warn" : ""}`, textContent: persona ?? "—" }),
      c.error ? badge("INVALID", "INVALID") : badge("QUEUED", "QUEUED"),
      ...(c.error ? [h("div", { className: "row-note err", textContent: c.error })] : c.warning ? [h("div", { className: "row-note", textContent: c.warning })] : []),
    );
  }

  function toggle(row: number, on: boolean): void {
    if (on) selected.add(row);
    else selected.delete(row);
  }

  function personaFor(c: SuiteCase): string | undefined {
    if (c.error) return c.personaLabel;
    const name = (id: string) => { const p = ctx.personas().find((x) => x.id === id); return p ? personaLabel(p, ctx.personas()) : id; };
    const extra = (c.extraPersonaIds ?? []).map(name);
    const d = ctx.defaultPersona();
    const first = c.personaId ? name(c.personaId) : d ? `${personaLabel(d, ctx.personas())} (default)` : undefined;
    return first ? [first, ...extra].join(" + ") : undefined;
  }

  function renderPersonaNote(): void {
    const needDefault = parsed?.cases.filter((c) => !c.error && !c.personaId && selected.has(c.row)).length ?? 0;
    const d = ctx.defaultPersona();
    personaNote.className = `hint${needDefault && !d ? " warn" : ""}`;
    personaNote.textContent = !needDefault ? "" : d
      ? `${needDefault} selected row${needDefault > 1 ? "s have" : " has"} no matching persona and will run as "${d.name}" (the Persona selected above).`
      : `${needDefault} selected row${needDefault > 1 ? "s have" : " has"} no matching persona. Select a default Persona above before running.`;
  }

  function renderReviewButtons(): void {
    const runnable = (rows: SuiteCase[]) => rows.filter((c) => !c.error && (c.personaId || ctx.defaultPersona()));
    const chosen = runnable(parsed!.cases.filter((c) => selected.has(c.row)));
    const everything = runnable(parsed!.cases);
    const blocked = !ctx.canRun();
    buttons.replaceChildren(
      h("button", { className: "btn secondary", textContent: "Clear", onclick: clear }),
      h("button", { className: "btn secondary", textContent: `Run Selected (${chosen.length})`, disabled: blocked || chosen.length === 0, onclick: () => void start(chosen) }),
      h("button", { className: "btn small", textContent: `Run All (${everything.length})`, disabled: blocked || everything.length === 0, onclick: () => void start(everything) }),
    );
    if (blocked) buttons.prepend(h("span", { className: "hint warn", textContent: "Connect the org first." }));
  }

  function clear(): void {
    if (isActive()) return;
    parsed = undefined;
    forgetSuite();
    selected.clear();
    for (const el of [table, buttons, personaNote]) el.replaceChildren();
    summary.hidden = true;
    review.element.hidden = true;
    showMessage("", "");
  }

  // --- Running ------------------------------------------------------------------

  async function start(cases: SuiteCase[]): Promise<void> {
    const d = ctx.defaultPersona();
    const project = ctx.project();
    batchScope = { orgId: ctx.orgId(), ...(project && { project }) };
    try {
      suite = await send({
        type: "startSuite",
        request: {
          orgId: ctx.orgId(),
          ...(parsed?.fileName && { fileName: parsed.fileName }),
          ...(d && { defaultPersonaId: d.id }),
          ...(project && { project }),
          cases: cases.map((c) => ({
            tcId: c.tcId!,
            title: c.title,
            ...(c.module && { module: c.module }),
            ...(c.personaId && { personaId: c.personaId }),
            ...(c.extraPersonaIds?.length && { extraPersonaIds: c.extraPersonaIds }),
            body: c.body,
          })),
        },
      });
    } catch (err) {
      return showMessage("err", (err as Error).message);
    }
    void chrome.storage.local.set({ [LAST_SUITE_KEY]: suite.id });
    renderSuite();
    watch();
  }

  function watch(): void {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!suite) return clearInterval(poll);
      try {
        suite = await send({ type: "getSuite", id: suite.id });
      } catch {
        return; // keep the last known state; the server may be busy
      }
      renderSuite();
      if (!isActive()) clearInterval(poll);
    }, POLL_MS);
  }

  function isActive(): boolean {
    return Boolean(suite && suite.summary.pending > 0);
  }

  function renderSuite(): void {
    if (!suite) return;
    const s = suite.summary;
    const running = suite.items.find((i) => i.status === "running");
    const done = s.total - s.pending;
    showMessage(s.pending ? "" : "ok", s.pending
      ? `Running ${suite.id}: ${done} of ${s.total} done${running ? `, now ${running.tcId}` : ""}. Tests run one at a time.`
      : `Batch ${suite.id} finished.`);
    personaNote.replaceChildren();
    table.replaceChildren(headerRow(), ...suite.items.map(suiteRow));
    buttons.replaceChildren(s.pending
      ? h("button", { className: "btn secondary", textContent: "Stop remaining", onclick: () => void stop() })
      : h("button", { className: "btn secondary", textContent: "Clear", onclick: clear }));
    renderSummary();
  }

  function suiteRow(i: SuiteItem): HTMLElement {
    const status = i.status === "completed" ? (i.verdict ?? "BLOCKED") : i.status.toUpperCase();
    const tc = i.displayId && i.status !== "queued"
      ? h("a", { className: "tc", textContent: i.tcId, href: "#", title: `Open ${i.displayId} in the report`, onclick: (e: Event) => { e.preventDefault(); void openReport(`#${i.displayId}`); } })
      : h("span", { className: "tc", textContent: i.tcId });
    return h("div", { className: "srow", title: i.error ?? "" },
      h("span", { className: "pad" }),
      tc,
      h("span", { className: "mod", textContent: i.module ?? "" }),
      h("span", { className: "ttl", textContent: i.title }),
      h("span", { className: "per", textContent: i.personaName }),
      badge(status, status),
      ...(i.bugs.length ? [h("div", { className: "row-note", textContent: `Bugs: ${i.bugs.join(", ")}` })] : []),
      ...(i.error ? [h("div", { className: "row-note err", textContent: i.error })] : []),
    );
  }

  function renderSummary(): void {
    if (!suite) return;
    const s = suite.summary;
    const stat = (label: string, value: number, cls = "") => h("div", { className: `stat ${cls}` }, h("div", { className: "v", textContent: String(value) }), h("div", { className: "l", textContent: label }));
    const bugs = [...new Set(suite.items.flatMap((i) => i.bugs))];
    summary.hidden = false;
    summary.replaceChildren(
      h("div", { className: "stats" },
        stat("Total", s.total), stat("Passed", s.passed, "PASS"), stat("Failed", s.failed, "FAIL"), stat("Blocked", s.blocked, "BLOCKED"),
        ...(s.errors ? [stat("Errors", s.errors, "FAIL")] : []),
        ...(s.cancelled ? [stat("Cancelled", s.cancelled)] : []),
        ...(s.pending ? [stat("Pending", s.pending)] : []),
      ),
      h("div", { className: "row end" },
        ...(bugs.length ? [h("button", { className: "btn secondary", textContent: `Bug report (${bugs.length})`, onclick: () => void openBugs(`#${bugs[0]}`) })] : []),
        h("button", { className: "btn small", textContent: "Open batch in report", onclick: () => void openReport(`#suite=${suite!.id}`) }),
      ),
    );
  }

  async function stop(): Promise<void> {
    if (!suite) return;
    try {
      suite = (await send({ type: "cancelSuite", id: suite.id })).suite;
      renderSuite();
    } catch (err) {
      showMessage("err", (err as Error).message);
    }
  }

  // --- Helpers ------------------------------------------------------------------

  function headerRow(all?: HTMLInputElement): HTMLElement {
    return h("div", { className: "srow head" },
      all ?? h("span", { className: "pad" }),
      h("span", { className: "tc", textContent: "TC ID" }),
      h("span", { className: "mod", textContent: "Module" }),
      h("span", { className: "ttl", textContent: "Title" }),
      h("span", { className: "per", textContent: "Persona" }),
      h("span", { className: "st", textContent: "Status" }),
    );
  }

  function badge(text: string, status: string): HTMLElement {
    return h("span", { className: `badge st ${status.replace("/", "")}`, textContent: text });
  }

  function showMessage(kind: "" | "ok" | "warn" | "err", text: string): void {
    message.className = `suite-msg ${kind}`;
    message.textContent = text;
  }

  function forgetSuite(): void {
    clearInterval(poll);
    suite = undefined;
    summary.hidden = true;
    void chrome.storage.local.remove(LAST_SUITE_KEY);
  }

  // Reports of the batch's own project and org (or, after a page reload, the current selection).
  const linksFor = () => send({ type: "getReportLinks", ...(batchScope ?? { orgId: ctx.orgId(), ...(ctx.project() && { project: ctx.project() }) }) }).catch(() => undefined);

  async function openReport(hash: string): Promise<void> {
    const links = await linksFor();
    if (links) window.open(`${links.executionReport}${hash}`, "_blank");
  }

  async function openBugs(hash: string): Promise<void> {
    const links = await linksFor();
    if (links) window.open(`${links.bugReport}${hash}`, "_blank");
  }

  // Re-renders persona-dependent parts, and picks a batch back up after a page reload.
  async function refresh(): Promise<void> {
    // A review started before a page reload is shown again even though the file has to be re-uploaded.
    if (!parsed) void review.resume().then((found) => { if (found) review.element.hidden = false; });
    if (parsed && !suite) return renderReview();
    if (suite) return renderSuite();
    const saved = await chrome.storage.local.get(LAST_SUITE_KEY).catch(() => ({} as Record<string, unknown>));
    const id = saved[LAST_SUITE_KEY] as string | undefined;
    if (!id) return;
    try {
      suite = await send({ type: "getSuite", id });
      renderSuite();
      if (isActive()) watch();
    } catch {
      void chrome.storage.local.remove(LAST_SUITE_KEY); // the server restarted and no longer knows it
    }
  }

  return { element, refresh: () => void refresh() };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
