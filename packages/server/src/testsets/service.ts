import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareRuns } from "@sfqa/shared";
import type { FinalResult, Org, Run, RunTestSetRequest, SaveTestSetRequest, StartSuiteRequest, Suite, SuiteItem, TestSet, TestSetRun } from "@sfqa/shared";
import { writeFileAtomic } from "../fs-utils.ts";
import type { ProjectStore } from "../projects/store.ts";
import type { RunStore } from "../runs/store.ts";
import type { SuiteStore } from "../suites/store.ts";

export interface TestSetDeps {
  // Sets without a project are saved in <qaRoot>/test-sets/<orgId>/.
  qaRoot: string;
  // With a project: <project>/<org>/Test Sets/.
  projects?: ProjectStore;
  suites: SuiteStore;
  runs: RunStore;
}

export class TestSetError extends Error {
  readonly code: "not_found" | "name_exists" | "running";
  constructor(code: TestSetError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_RUNS = 20;
const pad = (n: number) => String(n).padStart(2, "0");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A case's result after its re-check: failed twice = its first verdict, failed then passed = FLAKY.
export function finalOf(item: SuiteItem): FinalResult {
  if (item.status === "cancelled") return "CANCELLED";
  if (item.status === "error") return "ERROR";
  if (item.outcome === "flaky") return "FLAKY";
  return item.verdict ?? "BLOCKED";
}

// Saved Sanity and Regression sets. Each run is a normal batch; when the batch (and its re-checks)
// has finished, its final results are saved with the set, newest first, so the latest run can be
// compared with the one before it.
export class TestSetService {
  readonly #deps: TestSetDeps;
  #queue: Promise<unknown> = Promise.resolve();
  // Batches still running: suite id -> set id.
  #active = new Map<string, string>();

  constructor(deps: TestSetDeps) {
    this.#deps = deps;
    deps.runs.onFinished((run) => { void this.#onRunFinished(run); });
  }

  async list(orgId: string, project?: string): Promise<TestSet[]> {
    const index = await this.#readIndex();
    const sets: TestSet[] = [];
    for (const [id, entry] of Object.entries(index)) {
      if (entry.orgId !== orgId || (entry.project ?? "") !== (project ?? "")) continue;
      const set = await this.get(id);
      if (set) sets.push(set);
    }
    return sets.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  // The set with the comparison of its latest finished run against the finished run before it.
  async get(id: string): Promise<TestSet | undefined> {
    const set = await this.#load(id);
    if (!set) return undefined;
    const finished = set.runs.filter((r) => r.finishedAt && !r.interrupted);
    return finished[0] ? { ...set, comparison: compareRuns(finished[0], finished[1]) } : set;
  }

  save(org: Org, request: SaveTestSetRequest): Promise<TestSet> {
    return this.#serial(async () => {
      const existing = await this.list(org.id, request.project);
      const clash = existing.find((s) => same(s.name, request.name));
      if (clash) throw new TestSetError("name_exists", `A test set named "${clash.name}" already exists for this org. Choose another name or delete it first.`);
      const d = new Date();
      const stamp = `TS-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const index = await this.#readIndex();
      let id = stamp;
      for (let n = 2; index[id]; n++) id = `${stamp}-${n}`;
      const now = d.toISOString();
      const set: TestSet = {
        id, name: request.name.trim(), kind: request.kind, orgId: org.id, orgName: org.name,
        ...(request.project && { project: request.project }), ...(request.defaultPersonaId && { defaultPersonaId: request.defaultPersonaId }),
        cases: request.cases, createdOn: now, updatedOn: now, runs: [],
      };
      const file = join(await this.#folder(org, request.project), `${id}.json`);
      await this.#write(file, set);
      index[id] = { file, orgId: org.id, ...(request.project && { project: request.project }) };
      await this.#writeIndex(index);
      return set;
    });
  }

  delete(id: string): Promise<void> {
    return this.#serial(async () => {
      const index = await this.#readIndex();
      const entry = index[id];
      if (!entry) throw new TestSetError("not_found", `There is no test set ${id}.`);
      if ([...this.#active.values()].includes(id)) throw new TestSetError("running", "This test set is running. Stop the batch first.");
      // Only the set's own file goes; the runs' reports and screenshots stay where they are.
      await rm(entry.file, { force: true });
      delete index[id];
      await this.#writeIndex(index);
    });
  }

  // Starts the set as a batch (the same runner as an uploaded file) and records the run.
  async run(id: string, options: RunTestSetRequest, startSuite: (request: StartSuiteRequest) => Promise<Suite>): Promise<{ set: TestSet; suite: Suite }> {
    const set = await this.#load(id);
    if (!set) throw new TestSetError("not_found", `There is no test set ${id}.`);
    if ([...this.#active.values()].includes(id)) throw new TestSetError("running", "This test set is already running.");
    const defaultPersonaId = options.defaultPersonaId ?? set.defaultPersonaId;
    const suite = await startSuite({
      orgId: set.orgId,
      fileName: `${set.kind}: ${set.name}`,
      ...(defaultPersonaId && { defaultPersonaId }),
      ...(set.project && { project: set.project }),
      ...(options.fast !== undefined && { fast: options.fast }),
      recheck: options.recheck,
      cases: set.cases,
    });
    this.#active.set(suite.id, id);
    const entry: TestSetRun = { suiteId: suite.id, startedAt: new Date().toISOString(), fast: Boolean(options.fast), recheck: options.recheck, results: [] };
    const updated = await this.#update(id, (s) => { s.runs = [entry, ...s.runs].slice(0, MAX_RUNS); });
    return { set: updated, suite };
  }

  // When a set's batch has nothing left to run (re-checks included), its final results are saved.
  async #onRunFinished(run: Run): Promise<void> {
    const suiteId = run.request.suiteId;
    const setId = suiteId && this.#active.get(suiteId);
    if (!suiteId || !setId) return;
    const suite = this.#deps.suites.get(suiteId);
    if (!suite || suite.summary.pending > 0) return;
    const results = suite.items.map((i) => ({
      tcId: i.tcId, title: i.title, ...(i.displayId && { displayId: i.displayId }),
      ...(i.recheck?.displayId && { recheckDisplayId: i.recheck.displayId }), final: finalOf(i), bugs: i.bugs,
    }));
    // Still listed as active while saving, so loading the set does not take this run for an interrupted one.
    await this.#update(setId, (s) => {
      const r = s.runs.find((x) => x.suiteId === suiteId);
      if (r) {
        delete r.interrupted;
        Object.assign(r, { finishedAt: new Date().toISOString(), results });
      }
    }).catch(() => undefined);
    this.#active.delete(suiteId);
  }

  // --- Storage ---

  async #folder(org: Org, project?: string): Promise<string> {
    let dir = join(this.#deps.qaRoot, "test-sets", org.id);
    if (project && this.#deps.projects) {
      await this.#deps.projects.addOrg(project, org);
      dir = join(await this.#deps.projects.folder(project, org.id), "Test Sets");
    }
    await mkdir(dir, { recursive: true });
    return dir;
  }

  #indexFile(): string {
    return join(this.#deps.qaRoot, "test-sets", "index.json");
  }

  async #readIndex(): Promise<Record<string, { file: string; orgId: string; project?: string }>> {
    return JSON.parse(await readFile(this.#indexFile(), "utf8").catch(() => "{}")) as Record<string, { file: string; orgId: string; project?: string }>;
  }

  async #writeIndex(index: Record<string, { file: string; orgId: string; project?: string }>): Promise<void> {
    await mkdir(dirname(this.#indexFile()), { recursive: true });
    await writeFileAtomic(this.#indexFile(), `${JSON.stringify(index, null, 2)}\n`);
  }

  async #load(id: string): Promise<TestSet | undefined> {
    if (!/^TS-\d{8}-\d{6}(?:-\d{1,3})?$/.test(id)) return undefined;
    const entry = (await this.#readIndex())[id];
    if (!entry) return undefined;
    try {
      const set = JSON.parse(await readFile(entry.file, "utf8")) as TestSet;
      // A run that was going when the server stopped cannot finish any more.
      for (const r of set.runs) if (!r.finishedAt && !this.#active.has(r.suiteId)) Object.assign(r, { finishedAt: r.startedAt, interrupted: true });
      return set;
    } catch {
      return undefined;
    }
  }

  #update(id: string, change: (set: TestSet) => void): Promise<TestSet> {
    return this.#serial(async () => {
      const entry = (await this.#readIndex())[id];
      const set = await this.#load(id);
      if (!entry || !set) throw new TestSetError("not_found", `There is no test set ${id}.`);
      change(set);
      set.updatedOn = new Date().toISOString();
      await this.#write(entry.file, set);
      return set;
    });
  }

  async #write(file: string, set: TestSet): Promise<void> {
    const { comparison: _c, ...stored } = set;
    void _c;
    await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
