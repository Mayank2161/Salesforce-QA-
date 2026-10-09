import { randomBytes } from "node:crypto";
import { z } from "zod";
import { tokensMatch } from "../api/security.ts";
import {
  REPORT_SCHEMAS,
  type BugReport, type CallApi, type Create, type FinishReport, type FinishReview, type ListTestData, type Query, type ReportKind,
  type RequirementsReport, type StepReport, type Update, type VerdictReport,
} from "./protocol.ts";

// A test run provides the run tools; a test case review provides the review tools.
export interface AgentHandlers {
  step?(report: StepReport): Promise<string>;
  bug?(report: BugReport): Promise<string>;
  finish?(report: FinishReport): Promise<string>;
  // Test data setup; optional so a run can be started without it.
  query?(request: Query): Promise<string>;
  create?(request: Create): Promise<string>;
  update?(request: Update): Promise<string>;
  testdata?(request: ListTestData): Promise<string>;
  // API checks (Salesforce REST or a configured external system).
  api?(request: CallApi): Promise<string>;
  // Test case review against a requirements document.
  requirements?(report: RequirementsReport): Promise<string>;
  verdict?(report: VerdictReport): Promise<string>;
  reviewDone?(report: FinishReview): Promise<string>;
}

export interface DispatchResult {
  status: number;
  message: string;
}

// Routes QA tool calls from a run's Claude process to that run's handlers.
// Each run gets its own random key, so a process can only report into its own run.
export class AgentBridge {
  #runs = new Map<string, { key: string; handlers: AgentHandlers }>();

  open(runId: string, handlers: AgentHandlers): string {
    const key = randomBytes(24).toString("hex");
    this.#runs.set(runId, { key, handlers });
    return key;
  }

  close(runId: string): void {
    this.#runs.delete(runId);
  }

  async dispatch(runId: string, key: string | undefined, kind: string, body: unknown): Promise<DispatchResult> {
    const entry = this.#runs.get(runId);
    if (!entry || !tokensMatch(key, entry.key)) return { status: 403, message: "This run is not accepting reports." };
    if (!(kind in REPORT_SCHEMAS)) return { status: 404, message: `Unknown report kind ${kind}` };

    const parsed = REPORT_SCHEMAS[kind as ReportKind].safeParse(body);
    if (!parsed.success) return { status: 400, message: `Invalid ${kind} report:\n${z.prettifyError(parsed.error)}` };

    const handler = entry.handlers[kind as ReportKind] as ((report: unknown) => Promise<string>) | undefined;
    if (!handler) return { status: 404, message: `${kind} is not available in this run.` };
    try {
      return { status: 200, message: await handler(parsed.data) };
    } catch (err) {
      return { status: 422, message: (err as Error).message };
    }
  }
}
