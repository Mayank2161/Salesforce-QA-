import { CHANGES, type Change, type Persona, type TestSet, type TestSetRun } from "@sfqa/shared";
import { send } from "../messages.ts";
import { h } from "./dom.ts";

// Saved Sanity and Regression sets for the selected org (and project): run one with a click, and see
// the latest run compared with the one before (new failures, still failing, fixed, flaky).

export interface TestSetsContext {
  orgId(): string;
  orgName(): string | undefined;
  project(): string | undefined;
  defaultPersona(): Persona | undefined;
  fast(): boolean;
  canRun(): boolean;
  onBatchStarted(suiteId: string, scope: { orgId: string; project?: string }): void;
}

const CHANGE_CLASS: Record<Change, string> = {
  "New failure": "FAIL", "Still failing": "FAIL", Fixed: "PASS", Flaky: "BLOCKED", Passing: "PASS", New: "", "Not run": "",
};

export function createTestSetsPanel(ctx: TestSetsContext): { element: HTMLElement; refresh(): void } {
  let sets: TestSet[] = [];
  let open: string | undefined;

  const intro = h("div", { className: "hint" });
  const message = h("div", { className: "suite-msg" });
  const recheck = h("input", { type: "checkbox", checked: true });
  const list = h("div", { className: "set-list" });
  const element = h("div", { className: "testsets" },
    intro,
    h("label", { className: "chip", title: "Run every failed or blocked case once more to tell real failures from flaky ones" }, recheck, h("span", { textContent: "Re-check failures once" })),
    message,
    list,
  );

  async function refresh(): Promise<void> {
    const project = ctx.project();
    intro.textContent = `Saved Sanity and Regression sets for ${ctx.orgName() ?? "this org"}${project ? ` in project ${project}` : ""}. Create one from Upload file or from approved Jira test cases.`;
    try {
      sets = (await send({ type: "listTestSets", orgId: ctx.orgId(), ...(project && { project }) })).testSets;
      render();
    } catch (err) {
      show("err", (err as Error).message);
    }
  }

  function show(kind: "" | "ok" | "warn" | "err", text: string): void {
    message.className = `suite-msg ${kind}`;
    message.textContent = text;
  }

  function render(): void {
    list.replaceChildren(...(sets.length ? sets.map(card) : [h("div", { className: "hint", textContent: "No test sets yet." })]));
  }

  function lastRunLine(set: TestSet): string {
    const r = set.runs[0];
    if (!r) return "Not run yet";
    const when = new Date(r.startedAt).toLocaleString();
    if (!r.finishedAt) return `Running since ${when}`;
    if (r.interrupted) return `Last run ${when} was interrupted`;
    const n = (f: string) => r.results.filter((x) => x.final === f).length;
    return [`Last run ${when}`, `${n("PASS")} passed`, `${n("FAIL")} failed`, `${n("BLOCKED")} blocked`, ...(n("FLAKY") ? [`${n("FLAKY")} flaky`] : [])].join(" · ");
  }

  function card(set: TestSet): HTMLElement {
    const running = set.runs[0] && !set.runs[0].finishedAt;
    const run = h("button", { className: "btn small", type: "button", textContent: running ? "Running…" : `Run (${set.cases.length})`, disabled: running || !ctx.canRun() });
    run.title = ctx.canRun() ? "" : "Connect the org first.";
    run.onclick = () => void start(set);
    const results = h("button", { className: "btn secondary", type: "button", textContent: open === set.id ? "Hide results" : "Results", disabled: !set.comparison });
    results.onclick = () => { open = open === set.id ? undefined : set.id; render(); };
    const del = h("button", { className: "btn link danger", type: "button", textContent: "Delete" });
    del.onclick = () => void remove(set);
    return h("div", { className: "set-card" },
      h("div", { className: "set-head" },
        h("span", { className: `badge kind-${set.kind}`, textContent: set.kind }),
        h("span", { className: "set-name", textContent: set.name }),
        h("span", { className: "hint", textContent: `${set.cases.length} case${set.cases.length === 1 ? "" : "s"}` }),
      ),
      h("div", { className: "hint", textContent: lastRunLine(set) }),
      h("div", { className: "row" }, del, results, run),
      ...(open === set.id && set.comparison ? [comparison(set)] : []),
    );
  }

  // The latest finished run against the one before: counts per change, then one row per case.
  function comparison(set: TestSet): HTMLElement {
    const c = set.comparison!;
    const previous = set.runs.find((r: TestSetRun) => r.suiteId === c.previous);
    const chips = CHANGES.filter((k) => c.counts[k]).map((k) => h("span", { className: `badge ${CHANGE_CLASS[k]}`, textContent: `${k}: ${c.counts[k]}` }));
    const rows = [...c.rows].sort((a, b) => CHANGES.indexOf(a.change) - CHANGES.indexOf(b.change));
    return h("div", { className: "compare" },
      h("div", { className: "hint", textContent: previous ? `Compared with the run of ${new Date(previous.startedAt).toLocaleString()}.` : "First run: nothing to compare with yet." }),
      h("div", { className: "row compare-chips" }, ...chips),
      h("div", { className: "suite-table" },
        h("div", { className: "crow head" }, h("span", { textContent: "TC ID" }), h("span", { textContent: "Title" }), h("span", { textContent: "Before" }), h("span", { textContent: "Now" }), h("span", { textContent: "Change" })),
        ...rows.map((r) => {
          const tc = r.displayId
            ? h("a", { className: "tc", href: "#", textContent: r.tcId, title: `Open ${r.displayId} in the report`, onclick: (e: Event) => { e.preventDefault(); void openReport(r.displayId!); } })
            : h("span", { className: "tc", textContent: r.tcId });
          return h("div", { className: "crow" },
            tc,
            h("span", { className: "ttl", textContent: r.title + (r.bugs.length ? ` (${r.bugs.join(", ")})` : "") }),
            h("span", { textContent: r.previous ?? "–" }),
            h("span", { textContent: r.now }),
            h("span", {}, h("span", { className: `badge ${CHANGE_CLASS[r.change]}`, textContent: r.change })),
          );
        }),
      ),
    );
  }

  async function openReport(displayId: string): Promise<void> {
    const project = ctx.project();
    const links = await send({ type: "getReportLinks", orgId: ctx.orgId(), ...(project && { project }) }).catch(() => undefined);
    if (links) window.open(`${links.executionReport}#${displayId}`, "_blank");
  }

  async function start(set: TestSet): Promise<void> {
    if (!confirm(`Run the ${set.kind} set "${set.name}" (${set.cases.length} cases) in ${ctx.orgName() ?? "this org"}${ctx.fast() ? " with fast execution" : ""}${recheck.checked ? ", re-checking failures once" : ""}? Cases run one at a time.`)) return;
    try {
      const d = ctx.defaultPersona();
      const { suite } = await send({ type: "runTestSet", id: set.id, options: { fast: ctx.fast(), recheck: recheck.checked, ...(d && { defaultPersonaId: d.id }) } });
      show("ok", `Started "${set.name}". Progress is in the Upload file tab; come back here for the comparison when it finishes.`);
      ctx.onBatchStarted(suite.id, { orgId: set.orgId, ...(set.project && { project: set.project }) });
    } catch (err) {
      show("err", (err as Error).message);
    }
  }

  async function remove(set: TestSet): Promise<void> {
    if (!confirm(`Delete the test set "${set.name}"? Its runs' reports and screenshots are kept.`)) return;
    try {
      await send({ type: "deleteTestSet", id: set.id });
      await refresh();
      show("ok", `Deleted "${set.name}".`);
    } catch (err) {
      show("err", (err as Error).message);
    }
  }

  return { element, refresh: () => void refresh() };
}
