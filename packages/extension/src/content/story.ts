import { CASE_PRIORITIES, CASE_TYPES, type CaseReview, type CaseUpdate, type GeneratedCase, type Generation, type Persona } from "@sfqa/shared";
import { send } from "../messages.ts";
import { h } from "./dom.ts";

// Paste a Jira story -> Claude writes test cases -> review (approve, reject, edit) -> export to Excel
// -> run only the approved cases, with the normal batch runner. Generating never runs anything.

export interface StoryContext {
  orgId(): string;
  orgName(): string | undefined;
  project(): string | undefined;
  personas(): Persona[];
  defaultPersona(): Persona | undefined;
  fast(): boolean;
  canRun(): boolean;
  // A batch of approved cases was started: show it in the Upload file tab.
  onBatchStarted(suiteId: string, scope: { orgId: string; project?: string }): void;
}

const POLL_MS = 2500;
const LAST_GENERATION_KEY = "lastGenerationId";

export function createStoryPanel(ctx: StoryContext): { element: HTMLElement; refresh(): void } {
  let gen: Generation | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let filter: CaseReview | "All" = "All";
  let openCase: string | undefined;
  let editing: string | undefined;

  const keyInput = h("input", { placeholder: "Jira key, e.g. RMS-142 (optional)", maxLength: 40 });
  const storyInput = h("textarea", { className: "story-text", placeholder: "Paste the Jira story: summary, description, acceptance criteria, business rules and any notes." });
  const generateButton = h("button", { className: "btn primary block", type: "button", textContent: "Generate test cases" });
  const message = h("div", { className: "suite-msg" });
  const progress = h("div", { className: "story-progress", hidden: true });
  const results = h("div", { className: "story-results", hidden: true });

  const element = h("div", { className: "story" },
    h("div", { className: "hint", textContent: "Claude analyses the story and writes positive, negative, boundary, validation, permission, data and regression test cases. Nothing runs until you approve cases and click Run." }),
    keyInput, storyInput, generateButton, message, progress, results,
  );

  // --- Generating -------------------------------------------------------------------------------------

  generateButton.onclick = async () => {
    const text = storyInput.value.trim();
    if (text.length < 20) {
      message.className = "suite-msg warn";
      message.textContent = "Paste the story with its description and acceptance criteria.";
      return storyInput.focus();
    }
    generateButton.disabled = true;
    message.className = "suite-msg";
    message.textContent = "";
    try {
      const project = ctx.project();
      gen = await send({ type: "startGeneration", request: { orgId: ctx.orgId(), ...(project && { project }), story: { ...(keyInput.value.trim() && { key: keyInput.value.trim() }), text } } });
      void chrome.storage.local.set({ [LAST_GENERATION_KEY]: gen.id });
      openCase = editing = undefined;
      render();
      watch();
    } catch (err) {
      message.className = "suite-msg err";
      message.textContent = (err as Error).message;
      generateButton.disabled = false;
    }
  };

  function watch(): void {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!gen) return clearInterval(poll);
      try {
        gen = await send({ type: "getGeneration", id: gen.id });
      } catch {
        return;
      }
      render();
      if (gen.status !== "running") clearInterval(poll);
    }, POLL_MS);
  }

  // --- Rendering ------------------------------------------------------------------------------------

  function render(): void {
    const running = gen?.status === "running";
    generateButton.disabled = running;
    generateButton.textContent = running ? "Generating…" : "Generate test cases";
    progress.hidden = !gen || !running;
    if (gen && running) {
      progress.replaceChildren(
        h("div", { className: "suite-msg", textContent: `Analysing ${gen.storyKey}: ${gen.criteria.length} criteria, ${gen.cases.length} test cases so far…` }),
        h("div", { className: "bar" }, h("div", { className: "fill indeterminate" })),
        h("div", { className: "log", textContent: gen.log.slice(-6).join("\n") }),
      );
    }
    results.hidden = !gen || running;
    if (!gen || running) return;
    if (gen.status === "error") {
      results.replaceChildren(h("div", { className: "suite-msg err", textContent: `Generation failed: ${gen.error ?? "unknown error"}` }));
      return;
    }
    results.replaceChildren(summary(gen), coverage(gen), toolbar(gen), caseList(gen));
  }

  function count(g: Generation, review: CaseReview) {
    return g.cases.filter((c) => c.review === review).length;
  }

  function summary(g: Generation): HTMLElement {
    const byType = CASE_TYPES.map((t) => [t, g.cases.filter((c) => c.type === t).length] as const).filter(([, n]) => n);
    const stats = h("div", { className: "stats" },
      ...[["Test cases", g.cases.length, ""], ["Approved", count(g, "Approved"), "PASS"], ["Pending", count(g, "Pending"), ""], ["Rejected", count(g, "Rejected"), "FAIL"]]
        .map(([l, v, cls]) => h("div", { className: `stat ${cls}` }, h("div", { className: "v", textContent: String(v) }), h("div", { className: "l", textContent: String(l) }))),
    );
    return h("div", { className: "story-summary" },
      h("div", { className: "review-head" }, h("span", { textContent: `${g.storyKey} · ${g.orgName}${g.project ? ` · ${g.project}` : ""}` })),
      g.summary ? h("div", { className: "hint", textContent: g.summary }) : "",
      stats,
      h("div", { className: "hint", textContent: byType.map(([t, n]) => `${n} ${t.toLowerCase()}`).join(" · ") }),
    );
  }

  function coverage(g: Generation): HTMLElement {
    const covered = g.criteria.length - g.uncovered.length;
    const list = (title: string, items: string[]) => items.length
      ? h("details", { className: "more-box" }, h("summary", { textContent: `${title} (${items.length})` }), h("ul", {}, ...items.map((i) => h("li", { textContent: i }))))
      : "";
    return h("div", { className: "story-coverage" },
      h("div", { className: `suite-msg ${g.uncovered.length ? "warn" : "ok"}`, textContent: g.uncovered.length
        ? `${covered} of ${g.criteria.length} criteria covered. Not covered: ${g.uncovered.join(", ")}.`
        : `All ${g.criteria.length} acceptance criteria and requirements are covered.` }),
      h("details", { className: "more-box" }, h("summary", { textContent: `Traceability (${g.criteria.length} criteria)` }),
        h("ul", {}, ...g.criteria.map((cr) => {
          const ids = g.cases.filter((c) => c.criteria.includes(cr.id)).map((c) => c.tcId.replace(`${g.storyKey}_`, ""));
          return h("li", {}, h("strong", { textContent: `${cr.id}: ` }), cr.text, h("span", { className: ids.length ? "hint" : "hint warn", textContent: ` → ${ids.join(", ") || "no test case"}` }));
        }))),
      list("Gaps", g.gaps), list("Assumptions", g.assumptions), list("Questions for the business", g.questions), list("Possibly affected areas", g.affectedAreas),
    );
  }

  function toolbar(g: Generation): HTMLElement {
    const filterSelect = h("select", { className: "story-filter" },
      ...(["All", "Pending", "Approved", "Rejected"] as const).map((f) => h("option", { value: f, textContent: f === "All" ? `All (${g.cases.length})` : `${f} (${count(g, f)})`, selected: f === filter })));
    filterSelect.onchange = () => { filter = filterSelect.value as typeof filter; render(); };
    const approveAll = h("button", { className: "btn secondary", type: "button", textContent: "Approve all pending", disabled: !count(g, "Pending") });
    approveAll.onclick = async () => {
      for (const c of g.cases.filter((x) => x.review === "Pending")) await update(c.tcId, { review: "Approved" }, false);
      render();
    };
    const exportAll = h("button", { className: "btn secondary", type: "button", textContent: "Export all to Excel" });
    exportAll.onclick = () => void download(false);
    const exportApproved = h("button", { className: "btn secondary", type: "button", textContent: "Export approved", disabled: !count(g, "Approved") });
    exportApproved.onclick = () => void download(true);
    const approved = count(g, "Approved");
    const run = h("button", { className: "btn small", type: "button", textContent: `Run approved (${approved})`, disabled: !approved || !ctx.canRun() });
    run.title = ctx.canRun() ? "" : "Connect the org first.";
    run.onclick = () => void runApproved();
    return h("div", { className: "story-toolbar" },
      h("div", { className: "row" }, filterSelect, approveAll),
      h("div", { className: "row end" }, exportAll, exportApproved, run),
    );
  }

  function caseList(g: Generation): HTMLElement {
    const shown = g.cases.filter((c) => filter === "All" || c.review === filter);
    return h("div", { className: "case-list" },
      ...(shown.length ? shown.map((c) => caseCard(c)) : [h("div", { className: "hint", textContent: "No test cases in this view." })]));
  }

  function caseCard(c: GeneratedCase): HTMLElement {
    const open = openCase === c.tcId;
    const head = h("button", { className: "case-head", type: "button" },
      h("span", { className: "case-id", textContent: c.tcId.replace(`${c.storyId}_`, "") }),
      h("span", { className: `badge type-${c.type.replace(/\s+/g, "")}`, textContent: c.type }),
      h("span", { className: "case-title", textContent: c.scenario }),
      h("span", { className: `review-chip ${c.review}`, textContent: c.review + (c.edited ? " · edited" : "") }),
    );
    head.onclick = () => { openCase = open ? undefined : c.tcId; editing = undefined; render(); };
    const approve = h("button", { className: "btn small", type: "button", textContent: "Approve", disabled: c.review === "Approved" });
    approve.onclick = () => void update(c.tcId, { review: "Approved" });
    const reject = h("button", { className: "btn secondary", type: "button", textContent: "Reject", disabled: c.review === "Rejected" });
    reject.onclick = () => void update(c.tcId, { review: "Rejected" });
    const edit = h("button", { className: "btn link", type: "button", textContent: "Edit" });
    // Edit opens the card too: the editor is shown inside an open card.
    edit.onclick = () => { openCase = c.tcId; editing = c.tcId; render(); };
    const actions = h("div", { className: "row case-actions" }, edit, reject, approve);
    if (!open) return h("div", { className: `case ${c.review}` }, head, actions);
    return h("div", { className: `case open ${c.review}` }, head, editing === c.tcId ? editor(c) : details(c), editing === c.tcId ? "" : actions);
  }

  function details(c: GeneratedCase): HTMLElement {
    const f = (label: string, value: string | Node) => h("div", { className: "case-field" }, h("div", { className: "case-label", textContent: label }), typeof value === "string" ? h("div", { className: "case-value", textContent: value || "–" }) : value);
    return h("div", { className: "case-body" },
      f("Description", c.description),
      h("div", { className: "case-grid" }, f("Module", c.module), f("Priority", c.priority), f("Persona", c.persona), f("Criteria", c.criteria.join(", "))),
      f("Preconditions", c.preconditions),
      f("Test steps", h("ol", { className: "case-steps" }, ...c.steps.map((s) => h("li", { textContent: s })))),
      f("Test data", c.testData),
      f("Expected result", c.expected),
    );
  }

  function editor(c: GeneratedCase): HTMLElement {
    const input = (value: string) => h("input", { value });
    const area = (value: string, rows = 3) => h("textarea", { className: "case-edit", value, rows });
    const select = (values: readonly string[], value: string) => h("select", {}, ...values.map((v) => h("option", { value: v, textContent: v, selected: v === value })));
    const fields = {
      scenario: input(c.scenario), description: area(c.description), module: input(c.module), persona: input(c.persona),
      type: select(CASE_TYPES, c.type), priority: select(CASE_PRIORITIES, c.priority), preconditions: area(c.preconditions),
      steps: area(c.steps.join("\n"), Math.min(12, c.steps.length + 2)), testData: area(c.testData), expected: area(c.expected),
    };
    const error = h("div", { className: "hint warn" });
    const save = h("button", { className: "btn small", type: "button", textContent: "Save changes" });
    save.onclick = async () => {
      const steps = fields.steps.value.split("\n").map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
      if (!fields.scenario.value.trim() || !steps.length || !fields.expected.value.trim()) {
        error.textContent = "A test case needs a scenario, at least one step and an expected result.";
        return;
      }
      const ok = await update(c.tcId, {
        scenario: fields.scenario.value, description: fields.description.value, module: fields.module.value, persona: fields.persona.value,
        type: fields.type.value as GeneratedCase["type"], priority: fields.priority.value as GeneratedCase["priority"],
        preconditions: fields.preconditions.value, steps, testData: fields.testData.value, expected: fields.expected.value,
      });
      if (ok) editing = undefined;
      render();
    };
    const cancel = h("button", { className: "btn secondary", type: "button", textContent: "Cancel", onclick: () => { editing = undefined; render(); } });
    const l = (label: string, el: HTMLElement) => h("label", {}, label, el);
    return h("div", { className: "case-body" },
      l("Test scenario", fields.scenario), l("Description", fields.description),
      h("div", { className: "case-grid" }, l("Module", fields.module), l("Persona", fields.persona), l("Type", fields.type), l("Priority", fields.priority)),
      l("Preconditions", fields.preconditions), l("Test steps (one per line)", fields.steps), l("Test data", fields.testData), l("Expected result", fields.expected),
      error, h("div", { className: "row end" }, cancel, save),
    );
  }

  // --- Actions --------------------------------------------------------------------------------------

  async function update(tcId: string, change: CaseUpdate, rerender = true): Promise<boolean> {
    if (!gen) return false;
    try {
      const updated = await send({ type: "updateCase", id: gen.id, tcId, update: change });
      gen.cases = gen.cases.map((c) => (c.tcId === tcId ? updated : c));
      if (rerender) render();
      return true;
    } catch (err) {
      message.className = "suite-msg err";
      message.textContent = (err as Error).message;
      return false;
    }
  }

  async function download(approved: boolean): Promise<void> {
    if (!gen) return;
    try {
      const { dataUrl, fileName } = await send({ type: "exportCases", id: gen.id, approved });
      const a = h("a", { href: dataUrl, download: fileName });
      element.append(a);
      a.click();
      a.remove();
    } catch (err) {
      message.className = "suite-msg err";
      message.textContent = (err as Error).message;
    }
  }

  async function runApproved(): Promise<void> {
    if (!gen) return;
    const approved = gen.cases.filter((c) => c.review === "Approved");
    const personas = ctx.personas();
    const match = (name: string) => personas.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    const d = ctx.defaultPersona();
    const unmatched = approved.filter((c) => !match(c.persona));
    if (unmatched.length && !d) {
      message.className = "suite-msg warn";
      message.textContent = `No persona matches "${unmatched[0]!.persona}". Select a persona under Run as; it is used for cases without a match.`;
      return;
    }
    const where = `${ctx.orgName() ?? "this org"}${ctx.project() ? ` (project ${ctx.project()})` : ""}`;
    const note = unmatched.length ? `\n${unmatched.length} case(s) have no matching persona and will run as ${d!.name}.` : "";
    if (!confirm(`Run ${approved.length} approved test case(s) in ${where}${ctx.fast() ? " with fast execution" : ""}? They run one at a time.${note}`)) return;
    try {
      const project = ctx.project();
      const suite = await send({
        type: "startSuite",
        request: {
          orgId: ctx.orgId(),
          fileName: `${gen.storyKey} (generated test cases)`,
          ...(d && { defaultPersonaId: d.id }),
          ...(project && { project }),
          fast: ctx.fast(),
          cases: approved.map((c) => ({
            tcId: c.tcId,
            title: c.scenario.slice(0, 300),
            ...(c.module && { module: c.module.slice(0, 80) }),
            ...(match(c.persona) && { personaId: match(c.persona)!.id }),
            body: caseText(c),
          })),
        },
      });
      ctx.onBatchStarted(suite.id, { orgId: ctx.orgId(), ...(project && { project }) });
    } catch (err) {
      message.className = "suite-msg err";
      message.textContent = (err as Error).message;
    }
  }

  async function refresh(): Promise<void> {
    if (gen) return render();
    const saved = await chrome.storage.local.get(LAST_GENERATION_KEY).catch(() => ({} as Record<string, unknown>));
    const id = saved[LAST_GENERATION_KEY] as string | undefined;
    if (!id) return;
    try {
      gen = await send({ type: "getGeneration", id });
      render();
      if (gen.status === "running") watch();
    } catch {
      void chrome.storage.local.remove(LAST_GENERATION_KEY);
    }
  }

  return { element, refresh: () => void refresh() };
}

// The case as the test agent reads it: the same fields as the Excel sheet.
export function caseText(c: GeneratedCase): string {
  return [
    `Test Case ID: ${c.tcId}`,
    `Jira Story ID: ${c.storyId}`,
    `Module: ${c.module}`,
    `Test Scenario: ${c.scenario}`,
    `Test Case Description: ${c.description}`,
    `Test Type: ${c.type}`,
    `Priority: ${c.priority}`,
    `Persona: ${c.persona}`,
    `Preconditions: ${c.preconditions}`,
    `Test Data: ${c.testData}`,
    "Test Steps:",
    ...c.steps.map((s, i) => `${i + 1}. ${s}`),
    `Expected Result: ${c.expected}`,
  ].join("\n");
}
