import { z } from "zod";
import { IsoDateTime, SlugId } from "./ids.ts";

// A review checks uploaded test cases against a requirements document (BRD, requirement sheet):
// is each test case correct and traceable, and which requirements have no test case at all.
// Nothing is executed in Salesforce; Claude only reads the document and the test cases.

export const REVIEW_VERDICTS = ["Correct", "Needs update", "Incorrect", "Not traceable"] as const;
export const ReviewVerdict = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

// Requirements documents the server can read.
export const REQUIREMENTS_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"] as const;
export const MAX_REQUIREMENTS_BYTES = 10 * 1024 * 1024;

// Body of POST /reviews. The document travels as base64; the test cases are the reviewed rows.
export const StartReviewRequest = z.object({
  orgId: SlugId,
  testCasesFileName: z.string().max(255).optional(),
  requirements: z.object({
    fileName: z.string().min(1).max(255),
    data: z.string().min(1),
  }),
  cases: z.array(z.object({
    tcId: z.string().trim().min(1).max(60),
    title: z.string().max(300),
    module: z.string().max(80).optional(),
    body: z.string().trim().min(1).max(20_000),
  })).min(1).max(200),
});
export type StartReviewRequest = z.infer<typeof StartReviewRequest>;

export const ReviewStatus = z.enum(["running", "completed", "error"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const ReviewSummary = z.object({
  correct: z.int(),
  needsUpdate: z.int(),
  incorrect: z.int(),
  notTraceable: z.int(),
  requirements: z.int(),
  requirementsCovered: z.int(),
  gaps: z.int(),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;

// What GET /reviews/:id returns while the review runs and after it finishes.
export const Review = z.object({
  id: z.string().regex(/^REV-\d{8}-\d{3,}$/),
  orgId: SlugId,
  status: ReviewStatus,
  createdAt: IsoDateTime,
  testCasesFileName: z.string().optional(),
  requirementsFileName: z.string(),
  total: z.int(),
  reviewed: z.int(),
  summary: ReviewSummary.optional(),
  log: z.array(z.string()),
  error: z.string().optional(),
});
export type Review = z.infer<typeof Review>;
