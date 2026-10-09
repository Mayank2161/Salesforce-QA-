import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Org, Review, ReviewSummary, StartReviewRequest } from "@sfqa/shared";
import type { AgentBridge } from "../agent/bridge.ts";
import { runClaude as defaultRunClaude, type ClaudeSettings } from "../agent/claude.ts";
import type { FinishReview, RequirementsReport, VerdictReport } from "../agent/protocol.ts";
import { reportTimestamp, type QaWorkspace, type ReviewRecord } from "../reports/workspace.ts";
import type { RequirementsText } from "./extract.ts";
import { buildReviewPrompt } from "./prompt.ts";

export interface ReviewDeps {
  bridge: AgentBridge;
  qa: QaWorkspace;
  claude: ClaudeSettings;
  serverUrl: string;
  reviewMcpScript: string;
  // Per-review working folder (tool config) is created under here and removed afterwards.
  workDir: string;
  // Replaced in tests.
  runClaude?: typeof defaultRunClaude;
}

type Requirement = RequirementsReport["requirements"][number];
interface Case { tcId: string; title: string; module?: string; body: string }

interface State {
  id: string;
  org: Org;
  createdAt: string;
  testCasesFileName?: string;
  requirementsFileName: string;
  pages?: number;
  cases: Case[];
  requirements: Map<string, Requirement>;
  verdicts: Map<string, VerdictReport>;
  finish?: FinishReview;
  status: Review["status"];
  log: string[];
  error?: string;
  done: Promise<void>;
}

const MAX_LOG = 60;

// Reviews uploaded test cases against a requirements document with Claude. One review at a time;
// progress is kept in memory for the panel and the finished review goes into qa/reviews/review-data.js.
export class ReviewService {
  #reviews = new Map<string, State>();
  #active: string | undefined;
  readonly #deps: ReviewDeps;

  constructor(deps: ReviewDeps) {
    this.#deps = deps;
  }

  busy(): boolean {
    return this.#active !== undefined;
  }

  get(id: string): Review | undefined {
    const s = this.#reviews.get(id);
    return s && view(s);
  }

  // Resolves when the review has finished (for tests).
  wait(id: string): Promise<void> {
    return this.#reviews.get(id)?.done ?? Promise.resolve();
  }

  async start(org: Org, request: StartReviewRequest, requirements: RequirementsText): Promise<Review> {
    if (this.#active) throw new Error("A review is already running.");
    const id = await this.#deps.qa.nextReviewId();
    // Duplicate TC IDs get a suffix so every row keeps its own verdict.
    const seen = new Map<string, number>();
    const cases = request.cases.map((c) => {
      const n = (seen.get(c.tcId) ?? 0) + 1;
      seen.set(c.tcId, n);
      return { ...c, tcId: n > 1 ? `${c.tcId} (${n})` : c.tcId };
    });
    const state: State = {
      id,
      org,
      createdAt: new Date().toISOString(),
      ...(request.testCasesFileName && { testCasesFileName: request.testCasesFileName }),
      requirementsFileName: request.requirements.fileName,
      ...(requirements.pages && { pages: requirements.pages }),
      cases,
      requirements: new Map(),
      verdicts: new Map(),
      status: "running",
      log: [],
      done: Promise.resolve(),
    };
    this.#reviews.set(id, state);
    this.#active = id;
    log(state, `Reading ${state.requirementsFileName}${state.pages ? ` (${state.pages} pages)` : ""} and ${cases.length} test case${cases.length > 1 ? "s" : ""}.`);
    state.done = this.#run(state, requirements.text).finally(() => { this.#active = undefined; });
    return view(state);
  }

  async #run(state: State, requirementsText: string): Promise<void> {
    const { bridge, qa, claude } = this.#deps;
    const dir = join(this.#deps.workDir, `review-${state.id}`);
    const mcpConfig = join(dir, "mcp.json");
    try {
      const key = bridge.open(state.id, handlers(state));
      await mkdir(dir, { recursive: true });
      await writeFile(mcpConfig, JSON.stringify({
        mcpServers: {
          qa: {
            command: process.execPath,
            args: [this.#deps.reviewMcpScript],
            env: { SFQA_URL: this.#deps.serverUrl, SFQA_RUN_ID: state.id, SFQA_RUN_KEY: key },
          },
        },
      }, null, 2));
      const result = await (this.#deps.runClaude ?? defaultRunClaude)({
        // One tool call per test case plus requirements and retries; long batches need more time.
        settings: { ...claude, maxTurns: Math.max(claude.maxTurns, state.cases.length * 2 + 30), timeoutMs: Math.max(claude.timeoutMs, state.cases.length * 40_000) },
        cwd: dir,
        mcpConfigPath: mcpConfig,
        allowedTools: ["mcp__qa"],
        prompt: buildReviewPrompt({
          orgName: state.org.name,
          reviewId: state.id,
          requirementsFileName: state.requirementsFileName,
          requirementsText,
          ...(state.testCasesFileName && { testCasesFileName: state.testCasesFileName }),
          cases: state.cases,
        }),
        onLog: (_level, message) => log(state, message),
      });
      if (!result.ok) log(state, result.error ?? "Claude stopped with an error.");

      if (state.verdicts.size === 0) {
        state.error = result.error ?? "The review stopped before any test case was reviewed.";
        state.status = "error";
        return;
      }
      await qa.appendReview(record(state, claude.model));
      state.status = "completed";
      log(state, state.finish && state.verdicts.size === state.cases.length
        ? `Review ${state.id} finished.`
        : `Review ${state.id} stopped early: ${state.verdicts.size} of ${state.cases.length} test cases reviewed. The report shows what was done.`);
    } catch (err) {
      state.error = (err as Error).message;
      state.status = "error";
      log(state, state.error);
    } finally {
      bridge.close(state.id);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function log(state: State, message: string): void {
  state.log.push(`${new Date().toLocaleTimeString()}  ${message}`);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

// Validates Claude's review tool calls; an error message is returned to Claude so it can fix the call.
function handlers(state: State) {
  const known = (ids: string[]) => ids.filter((r) => !state.requirements.has(r));
  const idList = () => [...state.requirements.keys()].slice(0, 60).join(", ");
  return {
    async requirements(r: RequirementsReport) {
      for (const req of r.requirements) state.requirements.set(req.id, req);
      log(state, `Found ${r.requirements.length} requirement${r.requirements.length > 1 ? "s" : ""} in the document (${state.requirements.size} in total).`);
      return `Recorded ${r.requirements.length} requirement(s); ${state.requirements.size} in total. Now review each test case with review_test_case.`;
    },
    async verdict(r: VerdictReport) {
      if (state.requirements.size === 0) throw new Error("Call record_requirements first, with the requirements from the document.");
      if (!state.cases.some((c) => c.tcId === r.tcId)) {
        throw new Error(`"${r.tcId}" is not one of the test cases. Use a TC ID exactly as listed: ${state.cases.slice(0, 40).map((c) => c.tcId).join(", ")}.`);
      }
      const unknown = known(r.requirementIds);
      if (unknown.length) throw new Error(`Unknown requirement ID(s): ${unknown.join(", ")}. Record them with record_requirements first, or use one of: ${idList()}.`);
      if (r.verdict === "Correct" && r.requirementIds.length === 0) throw new Error('A "Correct" test case must list the requirementIds it verifies.');
      if (r.verdict === "Not traceable" && r.requirementIds.length > 0) throw new Error('"Not traceable" means no requirement covers it; leave requirementIds empty, or choose another verdict.');
      if ((r.verdict === "Needs update" || r.verdict === "Incorrect") && (r.issues.length === 0 || !(r.suggestedExpected || r.suggestedSteps))) {
        throw new Error(`"${r.verdict}" needs at least one issue and the corrected suggestedExpected and/or suggestedSteps.`);
      }
      state.verdicts.set(r.tcId, r);
      log(state, `${r.tcId}: ${r.verdict}`);
      const next = state.cases.find((c) => !state.verdicts.has(c.tcId));
      return `Recorded ${r.tcId} (${state.verdicts.size} of ${state.cases.length}).${next ? ` Next: ${next.tcId}.` : " All test cases are reviewed; call finish_review."}`;
    },
    async reviewDone(r: FinishReview) {
      if (state.finish) throw new Error("finish_review was already called. Stop now.");
      const missing = state.cases.filter((c) => !state.verdicts.has(c.tcId)).map((c) => c.tcId);
      if (missing.length) throw new Error(`These test cases have no verdict yet: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", ..." : ""}. Review them with review_test_case, then call finish_review again.`);
      const unknown = known(r.gaps.flatMap((g) => g.requirementIds));
      if (unknown.length) throw new Error(`Unknown requirement ID(s) in gaps: ${[...new Set(unknown)].join(", ")}. Use one of: ${idList()}.`);
      state.finish = r;
      log(state, `Coverage gaps found: ${r.gaps.length}.`);
      return "Review recorded. Stop now.";
    },
  };
}

function summarize(state: State): ReviewSummary {
  const v = [...state.verdicts.values()];
  const count = (verdict: string) => v.filter((x) => x.verdict === verdict).length;
  const covered = new Set(v.filter((x) => x.verdict === "Correct" || x.verdict === "Needs update").flatMap((x) => x.requirementIds));
  return {
    correct: count("Correct"),
    needsUpdate: count("Needs update"),
    incorrect: count("Incorrect"),
    notTraceable: count("Not traceable"),
    requirements: state.requirements.size,
    requirementsCovered: [...state.requirements.keys()].filter((id) => covered.has(id)).length,
    gaps: state.finish?.gaps.length ?? 0,
  };
}

function view(s: State): Review {
  return {
    id: s.id,
    orgId: s.org.id,
    status: s.status,
    createdAt: s.createdAt,
    ...(s.testCasesFileName && { testCasesFileName: s.testCasesFileName }),
    requirementsFileName: s.requirementsFileName,
    total: s.cases.length,
    reviewed: s.verdicts.size,
    ...(s.verdicts.size > 0 && { summary: summarize(s) }),
    log: s.log.slice(-15),
    ...(s.error && { error: s.error }),
  };
}

// The review in the format the report page reads (qa/reviews/review-data.js).
function record(s: State, model: string): ReviewRecord {
  const complete = Boolean(s.finish) && s.verdicts.size === s.cases.length;
  return {
    reviewId: s.id,
    createdOn: reportTimestamp(new Date(s.createdAt)),
    environment: s.org.name,
    testCasesFile: s.testCasesFileName ?? "",
    requirementsFile: s.requirementsFileName,
    ...(s.pages && { requirementsPages: s.pages }),
    reviewedBy: `Claude Code (${model})`,
    status: complete ? "Complete" : "Incomplete",
    summary: s.finish?.summary ?? `The review stopped before finishing: ${s.verdicts.size} of ${s.cases.length} test cases were reviewed and coverage gaps were not assessed.`,
    risks: s.finish?.risks ?? [],
    requirements: [...s.requirements.values()],
    cases: s.cases.map((c) => {
      const v = s.verdicts.get(c.tcId);
      return {
        tcId: c.tcId,
        title: c.title,
        module: c.module ?? "",
        verdict: v?.verdict ?? "Not reviewed",
        requirementIds: v?.requirementIds ?? [],
        issues: v?.issues ?? [],
        summary: v?.summary ?? "",
        ...(v?.suggestedSteps && { suggestedSteps: v.suggestedSteps }),
        ...(v?.suggestedExpected && { suggestedExpected: v.suggestedExpected }),
        testCaseText: c.body,
      };
    }),
    gaps: s.finish?.gaps ?? [],
  };
}
