import { z } from "zod";
import { IsoDateTime, RunId, SlugId } from "./ids.ts";
import { DisplayRunId, RunStatus, Verdict } from "./run.ts";
import { ProjectName } from "./test-case.ts";

// A batch ("suite") of test cases uploaded from an Excel/CSV file. Each case becomes one normal run;
// runs execute one at a time in upload order through the same runner as a single test.

// One row read from the file, before running.
export const SuiteCase = z.object({
  row: z.int().positive(), // spreadsheet row number, for error messages
  tcId: z.string().optional(),
  title: z.string(),
  module: z.string().optional(),
  // Persona as written in the file, and the configured persona it matched (if any).
  personaLabel: z.string().optional(),
  personaId: SlugId.optional(),
  // Further personas listed in the same cell ("Sales User, Sales Manager"), in order.
  extraPersonaIds: z.array(SlugId).optional(),
  // Test case text handed to Claude: the row's columns as labelled lines.
  body: z.string(),
  // Set when the row cannot be run (e.g. no TC ID).
  error: z.string().optional(),
  // Set when the row can run but needs attention (e.g. persona not found, so the default is used).
  warning: z.string().optional(),
});
export type SuiteCase = z.infer<typeof SuiteCase>;

// Body of POST /suites/parse. The file travels as base64.
export const ParseSuiteRequest = z.object({
  orgId: SlugId,
  fileName: z.string().min(1).max(255),
  data: z.string().min(1),
});
export type ParseSuiteRequest = z.infer<typeof ParseSuiteRequest>;

export const ParsedSuite = z.object({
  fileName: z.string(),
  sheet: z.string().optional(),
  columns: z.array(z.string()),
  missingColumns: z.array(z.string()),
  cases: z.array(SuiteCase),
});
export type ParsedSuite = z.infer<typeof ParsedSuite>;

// Body of POST /suites: the reviewed, selected cases to run.
export const StartSuiteRequest = z.object({
  orgId: SlugId,
  fileName: z.string().max(255).optional(),
  // Used for cases without a matched persona.
  defaultPersonaId: SlugId.optional(),
  // Project folder every row's reports are saved in.
  project: ProjectName.optional(),
  // Fast execution for every row of the batch.
  fast: z.boolean().optional(),
  // Run every FAIL or BLOCKED case once more: failing again confirms it, passing marks it flaky.
  recheck: z.boolean().optional(),
  cases: z.array(z.object({
    tcId: z.string().trim().min(1).max(60),
    title: z.string().max(300),
    module: z.string().max(80).optional(),
    personaId: SlugId.optional(),
    extraPersonaIds: z.array(SlugId).max(3).optional(),
    body: z.string().trim().min(1).max(20_000),
  })).min(1).max(200),
});
export type StartSuiteRequest = z.infer<typeof StartSuiteRequest>;

export const SuiteItemStatus = z.union([RunStatus, z.literal("cancelled")]);
export type SuiteItemStatus = z.infer<typeof SuiteItemStatus>;

export const SuiteItem = z.object({
  tcId: z.string(),
  title: z.string(),
  module: z.string().optional(),
  personaId: SlugId,
  personaName: z.string(),
  runId: RunId,
  displayId: DisplayRunId.optional(),
  status: SuiteItemStatus,
  verdict: Verdict.optional(),
  bugs: z.array(z.string()),
  error: z.string().optional(),
  // The automatic re-check of a FAIL/BLOCKED case, and what it showed: "confirmed" (failed again)
  // or "flaky" (passed the second time). No outcome while it runs, or if it could not run.
  recheck: z.object({
    runId: RunId,
    displayId: DisplayRunId.optional(),
    status: SuiteItemStatus,
    verdict: Verdict.optional(),
  }).optional(),
  outcome: z.enum(["confirmed", "flaky"]).optional(),
});
export type SuiteItem = z.infer<typeof SuiteItem>;

export const SuiteSummary = z.object({
  total: z.int(),
  passed: z.int(),
  failed: z.int(),
  blocked: z.int(),
  errors: z.int(),
  cancelled: z.int(),
  pending: z.int(), // queued or running (a case also counts while its re-check runs)
  flaky: z.int().default(0), // failed first, passed on re-check
});
export type SuiteSummary = z.infer<typeof SuiteSummary>;

export const Suite = z.object({
  id: z.string().regex(/^SUITE-\d{8}-\d{6}(?:-\d+)?$/),
  orgId: SlugId,
  fileName: z.string().optional(),
  createdAt: IsoDateTime,
  items: z.array(SuiteItem),
  summary: SuiteSummary,
});
export type Suite = z.infer<typeof Suite>;

export function summarizeSuite(items: readonly Pick<SuiteItem, "status" | "verdict" | "recheck" | "outcome">[]): SuiteSummary {
  const s: SuiteSummary = { total: items.length, passed: 0, failed: 0, blocked: 0, errors: 0, cancelled: 0, pending: 0, flaky: 0 };
  const busy = (status?: string) => status === "queued" || status === "running";
  for (const i of items) {
    if (busy(i.status) || busy(i.recheck?.status)) s.pending++;
    else if (i.outcome === "flaky") s.flaky++;
    else if (i.status === "cancelled") s.cancelled++;
    else if (i.status === "error") s.errors++;
    else if (i.verdict === "PASS") s.passed++;
    else if (i.verdict === "FAIL") s.failed++;
    else s.blocked++;
  }
  return s;
}
