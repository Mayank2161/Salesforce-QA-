import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { overallVerdict } from "@sfqa/shared";
import type { BugRef, Run, RunEvent, RunRequest, StepResult, Verdict } from "@sfqa/shared";

type Listener = (event: RunEvent) => void;

const now = () => new Date().toISOString();

// In-memory run registry and event bus. Finished runs are also written to the qa/ reports.
export class RunStore {
  #runs = new Map<string, Run>();
  #events = new EventEmitter().setMaxListeners(100);

  create(request: RunRequest): Run {
    const run: Run = { id: randomUUID(), request, status: "queued", steps: [], bugs: [], createdAt: now() };
    this.#runs.set(run.id, run);
    return structuredClone(run);
  }

  get(id: string): Run | undefined {
    const run = this.#runs.get(id);
    return run && structuredClone(run);
  }

  list(): Run[] {
    return [...this.#runs.values()].reverse().map((r) => structuredClone(r));
  }

  subscribe(runId: string, listener: Listener): () => void {
    this.#events.on(runId, listener);
    return () => this.#events.off(runId, listener);
  }

  setDisplayId(id: string, displayId: string): void {
    this.#require(id).displayId = displayId;
  }

  markRunning(id: string): void {
    const run = this.#require(id);
    run.status = "running";
    run.startedAt = now();
    this.#emit({ type: "run.status", runId: id, status: run.status, at: run.startedAt });
  }

  addStep(id: string, step: StepResult): void {
    this.#require(id).steps.push(step);
    this.#emit({ type: "run.step", runId: id, step });
  }

  addBug(id: string, bug: BugRef): void {
    this.#require(id).bugs.push(bug);
    this.#emit({ type: "run.bug", runId: id, bug });
  }

  log(id: string, level: "info" | "warn" | "error", message: string): void {
    this.#require(id);
    this.#emit({ type: "run.log", runId: id, level, message, at: now() });
  }

  // Passing an error marks the run as crashed ("error") rather than completed with a verdict.
  // A declared verdict (from the agent) can only make the computed verdict worse.
  finish(id: string, error?: string, opts: { declared?: Verdict; summary?: string } = {}): void {
    const run = this.#require(id);
    run.finishedAt = now();
    if (opts.summary) run.summary = opts.summary;
    if (error === undefined) {
      run.status = "completed";
      run.verdict = overallVerdict(run.steps, opts.declared);
    } else {
      run.status = "error";
      run.error = error;
    }
    this.#emit({ type: "run.status", runId: id, status: run.status, at: run.finishedAt });
    this.#emit({ type: "run.completed", runId: id, run: structuredClone(run) });
  }

  #require(id: string): Run {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Unknown run ${id}`);
    return run;
  }

  #emit(event: RunEvent): void {
    this.#events.emit(event.runId, event);
  }
}
