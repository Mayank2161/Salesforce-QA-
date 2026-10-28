import { summarizeSuite } from "@sfqa/shared";
import type { Run, RunRequest, Suite, SuiteItem } from "@sfqa/shared";
import type { RunStore } from "../runs/store.ts";

export const CANCELLED = "Cancelled before it started.";

interface StoredItem {
  tcId: string;
  title: string;
  module?: string;
  personaId: string;
  personaName: string;
  runId: string;
  // The automatic second run of this case after a FAIL or BLOCKED result.
  recheckRunId?: string;
}

interface StoredSuite {
  id: string;
  orgId: string;
  fileName?: string;
  createdAt: string;
  items: StoredItem[];
  // Re-run each FAIL/BLOCKED case once.
  recheck?: boolean;
}

// Batches of uploaded test cases. A batch only remembers which run each row became;
// statuses and verdicts are always read live from the run store, so they cannot drift.
export class SuiteStore {
  #suites = new Map<string, StoredSuite>();
  readonly #runs: RunStore;
  #startRun?: (request: RunRequest) => Run;

  constructor(runs: RunStore) {
    this.#runs = runs;
    runs.onFinished((run) => this.#onFinished(run));
  }

  // How re-check runs are queued (the same way the server queues any run).
  enableRechecks(startRun: (request: RunRequest) => Run): void {
    this.#startRun = startRun;
  }

  create(orgId: string, fileName: string | undefined, items: StoredItem[], now = new Date(), opts: { recheck?: boolean } = {}): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const base = `SUITE-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    let id = base;
    for (let n = 2; this.#suites.has(id); n++) id = `${base}-${n}`;
    this.#suites.set(id, { id, orgId, ...(fileName && { fileName }), createdAt: now.toISOString(), items, ...(opts.recheck && { recheck: true }) });
    return id;
  }

  // The id is created first because each run records which batch it belongs to.
  setItems(id: string, items: StoredItem[]): void {
    const s = this.#suites.get(id);
    if (s) s.items = items;
  }

  get(id: string): Suite | undefined {
    const s = this.#suites.get(id);
    if (!s) return undefined;
    const statusOf = (run: Run | undefined) => {
      const cancelled = run?.status === "error" && run.error === CANCELLED;
      return { cancelled, status: cancelled ? "cancelled" as const : (run?.status ?? "error") };
    };
    const items: SuiteItem[] = s.items.map((i) => {
      const run = this.#runs.get(i.runId);
      const { cancelled, status } = statusOf(run);
      const re = i.recheckRunId ? this.#runs.get(i.recheckRunId) : undefined;
      const reStatus = re && statusOf(re).status;
      // Failed again: confirmed. Passed the second time: flaky. Not decided while it runs or if it crashed.
      const outcome = re?.status === "completed" && re.verdict ? (re.verdict === "PASS" ? "flaky" as const : "confirmed" as const) : undefined;
      return {
        tcId: i.tcId,
        title: i.title,
        ...(i.module && { module: i.module }),
        personaId: i.personaId,
        personaName: i.personaName,
        runId: i.runId,
        ...(run?.displayId && { displayId: run.displayId }),
        status,
        ...(run?.verdict && { verdict: run.verdict }),
        bugs: [...new Set([...(run?.bugs ?? []), ...(re?.bugs ?? [])].map((b) => b.id))],
        ...(run?.error && !cancelled && { error: run.error }),
        ...(re && reStatus && {
          recheck: { runId: re.id, ...(re.displayId && { displayId: re.displayId }), status: reStatus, ...(re.verdict && { verdict: re.verdict }) },
        }),
        ...(outcome && { outcome }),
      };
    });
    return { id: s.id, orgId: s.orgId, ...(s.fileName && { fileName: s.fileName }), createdAt: s.createdAt, items, summary: summarizeSuite(items) };
  }

  // Cancels rows (and re-checks) that have not started; the running one finishes normally.
  cancel(id: string): number {
    const s = this.#suites.get(id);
    if (!s) return 0;
    let cancelled = 0;
    for (const runId of s.items.flatMap((i) => [i.runId, ...(i.recheckRunId ? [i.recheckRunId] : [])])) {
      if (this.#runs.get(runId)?.status === "queued") {
        this.#runs.finish(runId, CANCELLED);
        cancelled++;
      }
    }
    return cancelled;
  }

  // A row that ended FAIL or BLOCKED is run once more, as a new run of the same request. A re-check
  // is never re-checked, and runs that crashed or were cancelled are not re-run.
  #onFinished(run: Run): void {
    if (!this.#startRun || !run.request.suiteId || run.request.recheckOf || run.status !== "completed") return;
    if (run.verdict !== "FAIL" && run.verdict !== "BLOCKED") return;
    const s = this.#suites.get(run.request.suiteId);
    const item = s?.recheck ? s.items.find((i) => i.runId === run.id) : undefined;
    if (!item || item.recheckRunId) return;
    const { recheckOf: _ignored, ...request } = run.request;
    void _ignored;
    item.recheckRunId = this.#startRun({ ...request, recheckOf: run.id }).id;
  }
}
