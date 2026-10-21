import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaseUpdate, GeneratedCase, Generation, Org, StartGenerationRequest } from "@sfqa/shared";
import type { AgentBridge } from "../agent/bridge.ts";
import { runClaude as defaultRunClaude, type ClaudeSettings } from "../agent/claude.ts";
import type { CasesReport, CriteriaReport, FinishGeneration } from "../agent/protocol.ts";
import { writeFileAtomic } from "../fs-utils.ts";
import type { ProjectStore } from "../projects/store.ts";
import { buildGenerationPrompt } from "./prompt.ts";
import { buildXlsx } from "./xlsx.ts";

export interface GenerationDeps {
  bridge: AgentBridge;
  claude: ClaudeSettings;
  serverUrl: string;
  storyMcpScript: string;
  // Per-generation tool config is created under here and removed afterwards.
  workDir: string;
  // Where generations are saved without a project: <qaRoot>/test-cases/.
  qaRoot: string;
  // With a project: <project>/<org>/Test Cases/.
  projects?: ProjectStore;
  runClaude?: typeof defaultRunClaude;
}

export class GenerationError extends Error {
  readonly code: "busy" | "not_found" | "unknown_case" | "running";
  constructor(code: GenerationError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_LOG = 60;

// A Jira key as typed ("rms 142", "RMS:142") made safe for test case ids and file names: "RMS-142".
export function storyKeyOf(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 40) || "STORY";
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Turns pasted Jira stories into test cases with Claude, one generation at a time. Each generation
// is saved as JSON (and its Excel export next to it), so reviews and edits survive a restart.
export class GenerationService {
  readonly #deps: GenerationDeps;
  #gens = new Map<string, { gen: Generation; file: string }>();
  #active: string | undefined;
  #done = new Map<string, Promise<void>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: GenerationDeps) {
    this.#deps = deps;
  }

  busy(): boolean {
    return this.#active !== undefined;
  }

  // For tests: resolves once the generation has finished.
  wait(id: string): Promise<void> {
    return this.#done.get(id) ?? Promise.resolve();
  }

  async start(org: Org, request: StartGenerationRequest): Promise<Generation> {
    if (this.#active) throw new GenerationError("busy", "Test cases are already being generated. Wait for that to finish.");
    // Claimed before any await, so a second request arriving meanwhile is refused instead of starting too.
    this.#active = "starting";
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `GEN-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      // Two generations in the same second get -2, -3, ... so neither overwrites the other's file.
      const index = await this.#readIndex();
      let id = stamp;
      for (let n = 2; this.#gens.has(id) || index[id]; n++) id = `${stamp}-${n}`;
      // The key ends up in test case ids and file names: letters, digits, - and _ only.
      const storyKey = storyKeyOf(request.story.key || /\b[A-Z][A-Z0-9]+-\d+\b/.exec(request.story.text)?.[0] || "STORY");
      const gen: Generation = {
        id, orgId: org.id, orgName: org.name, ...(request.project && { project: request.project }), storyKey, status: "running",
        createdAt: d.toISOString(), criteria: [], cases: [], uncovered: [], gaps: [], assumptions: [], questions: [], affectedAreas: [], log: [],
      };
      const file = join(await this.#folder(org, request.project), `${id}.json`);
      this.#gens.set(id, { gen, file });
      await this.#save(id);
      await this.#index(id, file);
      this.#active = id;
      return this.#launch(gen, org, request.story.text);
    } catch (err) {
      this.#active = undefined;
      throw err;
    }
  }

  #launch(gen: Generation, org: Org, storyText: string): Generation {
    this.#log(gen, `Analysing story ${gen.storyKey}.`);
    this.#done.set(gen.id, this.#run(gen, org, storyText).finally(() => { this.#active = undefined; }));
    return structuredClone(gen);
  }

  async get(id: string): Promise<Generation | undefined> {
    const entry = this.#gens.get(id) ?? (await this.#load(id));
    return entry && structuredClone(entry.gen);
  }

  // Edits, approves or rejects one case. Only after generation has finished.
  updateCase(id: string, tcId: string, update: CaseUpdate): Promise<GeneratedCase> {
    return this.#serial(async () => {
      const entry = this.#gens.get(id) ?? (await this.#load(id));
      if (!entry) throw new GenerationError("not_found", `There is no generation ${id}.`);
      if (entry.gen.status === "running") throw new GenerationError("running", "Wait until generation has finished before editing cases.");
      const c = entry.gen.cases.find((x) => x.tcId === tcId);
      if (!c) throw new GenerationError("unknown_case", `There is no test case ${tcId}.`);
      const { review, ...fields } = update;
      const changed = Object.entries(fields).some(([k, v]) => v !== undefined && JSON.stringify(v) !== JSON.stringify((c as Record<string, unknown>)[k]));
      Object.assign(c, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
      if (changed) c.edited = true;
      if (review) c.review = review;
      await this.#save(id);
      return structuredClone(c);
    });
  }

  // Excel workbook: test cases (all, or only approved), traceability, and notes. Also saved next to
  // the generation's JSON.
  async exportXlsx(id: string, onlyApproved = false): Promise<{ data: Uint8Array; fileName: string }> {
    const gen = await this.get(id);
    if (!gen) throw new GenerationError("not_found", `There is no generation ${id}.`);
    const cases = onlyApproved ? gen.cases.filter((c) => c.review === "Approved") : gen.cases;
    const data = buildXlsx([
      {
        name: "Test Cases",
        columns: [
          { header: "Test Case ID", width: 18 }, { header: "Jira Story ID", width: 14 }, { header: "Module", width: 16 },
          { header: "Test Scenario", width: 36 }, { header: "Test Case Description", width: 44 }, { header: "Test Type", width: 14 },
          { header: "Priority", width: 10 }, { header: "Persona", width: 18 }, { header: "Preconditions", width: 36 },
          { header: "Test Steps", width: 60 }, { header: "Test Data", width: 32 }, { header: "Expected Result", width: 48 },
          { header: "Actual Result", width: 30 }, { header: "Status", width: 10 }, { header: "Bug ID", width: 12 },
          { header: "Acceptance Criteria", width: 16 }, { header: "Review", width: 11 },
        ],
        rows: cases.map((c) => [
          c.tcId, c.storyId, c.module, c.scenario, c.description, c.type, c.priority, c.persona, c.preconditions,
          c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), c.testData, c.expected, "", "", "", c.criteria.join(", "), c.review,
        ]),
      },
      {
        name: "Traceability",
        columns: [{ header: "Criterion", width: 12 }, { header: "Text", width: 70 }, { header: "Test Cases", width: 40 }, { header: "Covered", width: 10 }],
        rows: gen.criteria.map((cr) => {
          const ids = cases.filter((c) => c.criteria.includes(cr.id)).map((c) => c.tcId);
          return [cr.id, cr.text, ids.join(", "), ids.length ? "Yes" : "NO"];
        }),
      },
      {
        name: "Notes",
        columns: [{ header: "Type", width: 18 }, { header: "Note", width: 100 }],
        rows: [
          ...(gen.summary ? [["Summary", gen.summary]] : []),
          ...gen.gaps.map((g) => ["Gap", g]),
          ...gen.assumptions.map((a) => ["Assumption", a]),
          ...gen.questions.map((q) => ["Question", q]),
          ...gen.affectedAreas.map((a) => ["Affected area", a]),
        ],
      },
    ]);
    const fileName = `${gen.storyKey}_TestCases${onlyApproved ? "_Approved" : ""}.xlsx`;
    const entry = this.#gens.get(id)!;
    await writeFile(join(dirname(entry.file), `${gen.id}_${fileName}`), data).catch(() => undefined);
    return { data, fileName };
  }

  // --- Running Claude ---

  async #run(gen: Generation, org: Org, storyText: string): Promise<void> {
    const { bridge, claude } = this.#deps;
    const dir = join(this.#deps.workDir, `generation-${gen.id}`);
    const mcpConfig = join(dir, "mcp.json");
    let finished: FinishGeneration | undefined;
    try {
      const key = bridge.open(gen.id, {
        criteria: async (r: CriteriaReport) => this.#serial(async () => {
          for (const c of r.criteria) {
            if (gen.criteria.some((x) => x.id === c.id)) throw new Error(`Criterion ${c.id} was already recorded. Use new ids for new criteria.`);
          }
          gen.criteria.push(...r.criteria);
          this.#log(gen, `Found ${gen.criteria.length} acceptance criteria and requirements.`);
          await this.#save(gen.id);
          return `Recorded ${r.criteria.length} criteria. Now write the test cases with add_test_cases.`;
        }),
        cases: async (r: CasesReport) => this.#serial(async () => {
          if (!gen.criteria.length) throw new Error("Call record_criteria first.");
          const known = new Set(gen.criteria.map((c) => c.id));
          const added: string[] = [];
          const skipped: string[] = [];
          for (const c of r.cases) {
            const unknown = c.criteria.filter((id) => !known.has(id));
            if (unknown.length) throw new Error(`Case "${c.scenario}" links to unknown criteria ${unknown.join(", ")}. Use ids from record_criteria (or record the missing ones first). No case of this call was added.`);
          }
          for (const c of r.cases) {
            const fingerprint = norm(`${c.scenario} ${c.steps.join(" ")}`);
            if (gen.cases.some((x) => norm(x.scenario) === norm(c.scenario) || norm(`${x.scenario} ${x.steps.join(" ")}`) === fingerprint)) {
              skipped.push(c.scenario);
              continue;
            }
            const tcId = `${gen.storyKey}_TC_${String(gen.cases.length + 1).padStart(3, "0")}`;
            gen.cases.push({ tcId, storyId: gen.storyKey, ...c, review: "Pending" });
            added.push(tcId);
          }
          this.#log(gen, `${gen.cases.length} test cases so far.`);
          await this.#save(gen.id);
          return `Added ${added.join(", ") || "none"}.${skipped.length ? ` Skipped duplicates: ${skipped.join("; ")}.` : ""}`;
        }),
        generationDone: async (r: FinishGeneration) => this.#serial(async () => {
          if (finished) throw new Error("finish_generation was already called. Stop now.");
          if (!gen.cases.length) throw new Error("No test cases were added. Add them with add_test_cases first.");
          finished = r;
          return "Generation recorded. Stop now.";
        }),
      });
      await mkdir(dir, { recursive: true });
      await writeFile(mcpConfig, JSON.stringify({
        mcpServers: { qa: { command: process.execPath, args: [this.#deps.storyMcpScript], env: { SFQA_URL: this.#deps.serverUrl, SFQA_RUN_ID: gen.id, SFQA_RUN_KEY: key } } },
      }, null, 2));
      const result = await (this.#deps.runClaude ?? defaultRunClaude)({
        settings: { ...claude, maxTurns: Math.max(40, Math.min(claude.maxTurns, 80)), timeoutMs: Math.min(claude.timeoutMs, 20 * 60_000) },
        cwd: dir,
        mcpConfigPath: mcpConfig,
        allowedTools: ["mcp__qa"],
        prompt: buildGenerationPrompt({
          orgName: org.name, storyKey: gen.storyKey, storyText,
          personas: org.personas.map((p) => ({ name: p.name, ...(p.profile && { profile: p.profile }), ...(p.userFullName && { user: p.userFullName }) })),
        }),
        onLog: (_level, message) => this.#log(gen, message),
      });
      if (!result.ok) this.#log(gen, result.error ?? "Claude stopped with an error.");
      if (!gen.cases.length) {
        gen.status = "error";
        gen.error = result.error ?? "No test cases were generated.";
        return;
      }
      if (finished) Object.assign(gen, { summary: finished.summary, gaps: finished.gaps, assumptions: finished.assumptions, questions: finished.questions, affectedAreas: finished.affectedAreas });
      else gen.gaps.push("Generation stopped before Claude wrote its summary; review the cases for completeness.");
      gen.uncovered = gen.criteria.filter((cr) => !gen.cases.some((c) => c.criteria.includes(cr.id))).map((cr) => cr.id);
      gen.status = "completed";
      this.#log(gen, `Done: ${gen.cases.length} test cases for ${gen.criteria.length} criteria${gen.uncovered.length ? `; not covered: ${gen.uncovered.join(", ")}` : "; every criterion covered"}.`);
    } catch (err) {
      gen.status = "error";
      gen.error = (err as Error).message;
    } finally {
      bridge.close(gen.id);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await this.#serial(() => this.#save(gen.id)).catch(() => undefined);
    }
  }

  // --- Storage ---

  async #folder(org: Org, project?: string): Promise<string> {
    let dir = join(this.#deps.qaRoot, "test-cases");
    if (project && this.#deps.projects) {
      await this.#deps.projects.addOrg(project, org);
      dir = join(await this.#deps.projects.folder(project, org.id), "Test Cases");
    }
    await mkdir(dir, { recursive: true });
    return dir;
  }

  #indexFile(): string {
    return join(this.#deps.qaRoot, "test-cases", "index.json");
  }

  async #readIndex(): Promise<Record<string, string>> {
    return JSON.parse(await readFile(this.#indexFile(), "utf8").catch(() => "{}")) as Record<string, string>;
  }

  async #index(id: string, file: string): Promise<void> {
    await this.#serial(async () => {
      const index = await this.#readIndex();
      index[id] = file;
      await mkdir(dirname(this.#indexFile()), { recursive: true });
      await writeFileAtomic(this.#indexFile(), `${JSON.stringify(index, null, 2)}\n`);
    });
  }

  async #load(id: string): Promise<{ gen: Generation; file: string } | undefined> {
    if (!/^GEN-\d{8}-\d{6}(?:-\d{1,3})?$/.test(id)) return undefined;
    const index = await this.#readIndex();
    const file = index[id];
    if (!file) return undefined;
    try {
      const gen = JSON.parse(await readFile(file, "utf8")) as Generation;
      // A generation that was running when the server stopped will not continue.
      if (gen.status === "running") Object.assign(gen, { status: gen.cases.length ? "completed" : "error", error: gen.cases.length ? undefined : "The server stopped during generation." });
      const entry = { gen, file };
      this.#gens.set(id, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  async #save(id: string): Promise<void> {
    const entry = this.#gens.get(id);
    if (entry) await writeFileAtomic(entry.file, `${JSON.stringify(entry.gen, null, 2)}\n`);
  }

  #log(gen: Generation, message: string): void {
    gen.log = [...gen.log, `${new Date().toLocaleTimeString()}  ${message}`].slice(-MAX_LOG);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
