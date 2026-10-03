import { summarizeSuite } from "@sfqa/shared";
import type { Suite, SuiteItem } from "@sfqa/shared";
import type { RunStore } from "../runs/store.ts";

export const CANCELLED = "Cancelled before it started.";

interface StoredItem {
  tcId: string;
  title: string;
  module?: string;
  personaId: string;
  personaName: string;
  runId: string;
}

interface StoredSuite {
  id: string;
  orgId: string;
  fileName?: string;
  createdAt: string;
  items: StoredItem[];
}

// Batches of uploaded test cases. A batch only remembers which run each row became;
// statuses and verdicts are always read live from the run store, so they cannot drift.
export class SuiteStore {
  #suites = new Map<string, StoredSuite>();
  readonly #runs: RunStore;

  constructor(runs: RunStore) {
    this.#runs = runs;
  }

  create(orgId: string, fileName: string | undefined, items: StoredItem[], now = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const base = `SUITE-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    let id = base;
    for (let n = 2; this.#suites.has(id); n++) id = `${base}-${n}`;
    this.#suites.set(id, { id, orgId, ...(fileName && { fileName }), createdAt: now.toISOString(), items });
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
    const items: SuiteItem[] = s.items.map((i) => {
      const run = this.#runs.get(i.runId);
      const cancelled = run?.status === "error" && run.error === CANCELLED;
      return {
        tcId: i.tcId,
        title: i.title,
        ...(i.module && { module: i.module }),
        personaId: i.personaId,
        personaName: i.personaName,
        runId: i.runId,
        ...(run?.displayId && { displayId: run.displayId }),
        status: cancelled ? "cancelled" : (run?.status ?? "error"),
        ...(run?.verdict && { verdict: run.verdict }),
        bugs: [...new Set(run?.bugs.map((b) => b.id) ?? [])],
        ...(run?.error && !cancelled && { error: run.error }),
      };
    });
    return { id: s.id, orgId: s.orgId, ...(s.fileName && { fileName: s.fileName }), createdAt: s.createdAt, items, summary: summarizeSuite(items) };
  }

  // Cancels rows that have not started; the running one finishes normally.
  cancel(id: string): number {
    const s = this.#suites.get(id);
    if (!s) return 0;
    let cancelled = 0;
    for (const item of s.items) {
      if (this.#runs.get(item.runId)?.status === "queued") {
        this.#runs.finish(item.runId, CANCELLED);
        cancelled++;
      }
    }
    return cancelled;
  }
}
