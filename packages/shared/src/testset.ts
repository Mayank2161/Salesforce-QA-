import { z } from "zod";
import { SlugId } from "./ids.ts";
import { StartSuiteRequest } from "./suite.ts";
import { ProjectName } from "./test-case.ts";

// Saved test sets: a named group of test cases (Sanity or Regression) for one org (and project),
// run with one click. Each run is kept, so the latest run can be compared with the one before:
// what newly fails, what still fails, what got fixed and what is flaky.

export const TEST_SET_KINDS = ["Sanity", "Regression"] as const;
export const TestSetKind = z.enum(TEST_SET_KINDS);
export type TestSetKind = z.infer<typeof TestSetKind>;

export const TestSetCase = StartSuiteRequest.shape.cases.element;
export type TestSetCase = z.infer<typeof TestSetCase>;

// Body of POST /test-sets.
export const SaveTestSetRequest = z.object({
  name: z.string().trim().min(1).max(80),
  kind: TestSetKind,
  orgId: SlugId,
  project: ProjectName.optional(),
  defaultPersonaId: SlugId.optional(),
  cases: StartSuiteRequest.shape.cases,
});
export type SaveTestSetRequest = z.infer<typeof SaveTestSetRequest>;

// Body of POST /test-sets/:id/run.
export const RunTestSetRequest = z.object({
  fast: z.boolean().optional(),
  // Re-run each FAIL/BLOCKED case once (on by default for sets).
  recheck: z.boolean().default(true),
  defaultPersonaId: SlugId.optional(),
});
export type RunTestSetRequest = z.infer<typeof RunTestSetRequest>;

// A case's final result in one set run, after any re-check: FLAKY = failed, then passed.
export const FINAL_RESULTS = ["PASS", "FAIL", "BLOCKED", "FLAKY", "ERROR", "CANCELLED"] as const;
export const FinalResult = z.enum(FINAL_RESULTS);
export type FinalResult = z.infer<typeof FinalResult>;

export const TestSetResult = z.object({
  tcId: z.string(),
  title: z.string(),
  displayId: z.string().optional(),
  recheckDisplayId: z.string().optional(),
  final: FinalResult,
  bugs: z.array(z.string()),
});
export type TestSetResult = z.infer<typeof TestSetResult>;

export const TestSetRun = z.object({
  suiteId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  fast: z.boolean(),
  recheck: z.boolean(),
  // The server stopped before the run finished; its results are incomplete.
  interrupted: z.boolean().optional(),
  results: z.array(TestSetResult),
});
export type TestSetRun = z.infer<typeof TestSetRun>;

export const CHANGES = ["New failure", "Still failing", "Fixed", "Flaky", "Passing", "New", "Not run"] as const;
export const Change = z.enum(CHANGES);
export type Change = z.infer<typeof Change>;

export const Comparison = z.object({
  current: z.string(),
  previous: z.string().optional(),
  rows: z.array(z.object({ tcId: z.string(), title: z.string(), previous: FinalResult.optional(), now: FinalResult, change: Change, displayId: z.string().optional(), bugs: z.array(z.string()) })),
  counts: z.record(z.string(), z.number()),
});
export type Comparison = z.infer<typeof Comparison>;

export const TestSet = z.object({
  id: z.string(),
  name: z.string(),
  kind: TestSetKind,
  orgId: SlugId,
  orgName: z.string(),
  project: z.string().optional(),
  defaultPersonaId: SlugId.optional(),
  cases: z.array(TestSetCase),
  createdOn: z.string(),
  updatedOn: z.string(),
  // Newest first, at most 20.
  runs: z.array(TestSetRun),
  // The latest finished run against the finished run before it.
  comparison: Comparison.optional(),
});
export type TestSet = z.infer<typeof TestSet>;

// What changed for one case between two runs of a set.
export function changeOf(previous: FinalResult | undefined, now: FinalResult): Change {
  const bad = (r?: FinalResult) => r === "FAIL" || r === "BLOCKED";
  if (now === "ERROR" || now === "CANCELLED") return "Not run";
  if (now === "FLAKY") return "Flaky";
  if (previous === undefined || previous === "ERROR" || previous === "CANCELLED") return bad(now) ? "New failure" : now === "PASS" ? "New" : "Not run";
  if (bad(now)) return bad(previous) ? "Still failing" : "New failure";
  return bad(previous) || previous === "FLAKY" ? "Fixed" : "Passing";
}

// Compares a set's latest finished run with the finished run before it (cases matched by TC ID).
export function compareRuns(current: TestSetRun, previous?: TestSetRun): Comparison {
  const before = new Map((previous?.results ?? []).map((r) => [r.tcId, r]));
  const rows = current.results.map((r) => {
    const p = before.get(r.tcId);
    return {
      tcId: r.tcId, title: r.title, ...(p && { previous: p.final }), now: r.final,
      change: previous ? changeOf(p?.final, r.final) : (r.final === "FAIL" || r.final === "BLOCKED" ? "New failure" : changeOf(undefined, r.final)),
      ...(r.displayId && { displayId: r.displayId }), bugs: r.bugs,
    } as Comparison["rows"][number];
  });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.change] = (counts[row.change] ?? 0) + 1;
  return { current: current.suiteId, ...(previous && { previous: previous.suiteId }), rows, counts };
}
