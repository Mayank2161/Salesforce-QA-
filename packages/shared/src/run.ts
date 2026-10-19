import { z } from "zod";
import { IsoDateTime, RunId } from "./ids.ts";
import { RunRequest } from "./test-case.ts";

// Test outcome. BLOCKED means the step could not be evaluated
// (e.g. a precondition failed, missing permission, page never loaded).
export const Verdict = z.enum(["PASS", "FAIL", "BLOCKED"]);
export type Verdict = z.infer<typeof Verdict>;

// Steps may also be N/A (not applicable); N/A never affects the overall verdict.
export const StepStatus = z.enum(["PASS", "FAIL", "BLOCKED", "N/A"]);
export type StepStatus = z.infer<typeof StepStatus>;

// Lifecycle of the run itself, separate from the test outcome.
// "error" means the agent crashed, not that the test failed.
export const RunStatus = z.enum(["queued", "running", "completed", "error"]);
export type RunStatus = z.infer<typeof RunStatus>;

// Human-readable run id used in reports, e.g. RUN-20261001-001.
export const DisplayRunId = z.string().regex(/^RUN-\d{8}-\d{3,}$/);

export const StepResult = z.object({
  index: z.int().nonnegative(),
  // Step number as written in the test case ("3", "5a"); defaults to the index.
  label: z.string().max(20).optional(),
  description: z.string().min(1),
  status: StepStatus,
  expected: z.string().optional(),
  actual: z.string().optional(),
  // File names in the run's screenshot folder (qa/Screenshots/<displayId>/).
  screenshots: z.array(z.string()).default([]),
  notes: z.string().optional(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
});
export type StepResult = z.infer<typeof StepResult>;

export const BugSeverity = z.enum(["Critical", "High", "Medium", "Low"]);
export type BugSeverity = z.infer<typeof BugSeverity>;

export const BugRef = z.object({
  id: z.string().regex(/^BUG-\d{3,}$/),
  title: z.string(),
  severity: BugSeverity,
  // True when this run reproduced an existing bug rather than filing a new one.
  reproduced: z.boolean().optional(),
});
export type BugRef = z.infer<typeof BugRef>;

// Cost and speed of one run, for comparing execution modes. Token counts come from Claude Code's
// result; tool result sizes are measured from the stream (about 4 characters per token).
export const RunMetrics = z.object({
  // "hybrid": generic batched browser actions available; "classic": one Claude decision per browser action.
  mode: z.enum(["hybrid", "classic"]),
  totalMs: z.number().nonnegative(),
  claudeMs: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  toolCalls: z.record(z.string(), z.number().int()),
  // Browser operations performed: single tool calls plus every step inside a batch.
  browserActions: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  batchSteps: z.number().int().nonnegative(),
  // Batches that stopped on a step they could not perform, handing control back to Claude.
  batchFallbacks: z.number().int().nonnegative(),
  snapshots: z.number().int().nonnegative(),
  // Screenshots saved as evidence, and how many of them were sent to Claude as images.
  screenshots: z.number().int().nonnegative(),
  imagesToClaude: z.number().int().nonnegative(),
  // Fixed-time waits Claude asked for (browser_wait_for "time") and their total.
  fixedWaits: z.number().int().nonnegative(),
  fixedWaitSeconds: z.number().nonnegative(),
  toolResultChars: z.number().int().nonnegative(),
  snapshotChars: z.number().int().nonnegative(),
  tokens: z.object({
    input: z.number().int(), cacheCreation: z.number().int(), cacheRead: z.number().int(), output: z.number().int(),
  }).optional(),
  costUsd: z.number().optional(),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const Run = z.object({
  id: RunId,
  displayId: DisplayRunId.optional(),
  request: RunRequest,
  status: RunStatus,
  verdict: Verdict.optional(),
  steps: z.array(StepResult).default([]),
  bugs: z.array(BugRef).default([]),
  summary: z.string().optional(),
  error: z.string().optional(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
  metrics: RunMetrics.optional(),
  // Where this run's reports were saved: a project's org folder. Absent: the shared qa/ folder.
  reports: z.object({ project: z.string(), folder: z.string() }).optional(),
});
export type Run =z.infer<typeof Run>;

const SEVERITY: Record<Verdict, number> = { PASS: 0, BLOCKED: 1, FAIL: 2 };

// Overall verdict: any FAIL fails the run; otherwise any BLOCKED blocks it. N/A steps are ignored.
// No evaluated steps is BLOCKED, so a run can never pass by default. An agent-declared verdict can
// only make the result worse, never hide a failed step.
export function overallVerdict(steps: readonly Pick<StepResult, "status">[], declared?: Verdict): Verdict {
  const evaluated = steps.filter((s): s is { status: Verdict } => s.status !== "N/A");
  let verdict: Verdict = "PASS";
  if (evaluated.length === 0) verdict = "BLOCKED";
  else if (evaluated.some((s) => s.status === "FAIL")) verdict = "FAIL";
  else if (evaluated.some((s) => s.status === "BLOCKED")) verdict = "BLOCKED";
  if (declared && SEVERITY[declared] > SEVERITY[verdict]) verdict = declared;
  return verdict;
}
