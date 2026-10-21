import { z } from "zod";
import { SlugId } from "./ids.ts";
import { ProjectName } from "./test-case.ts";

// Test cases generated from a pasted Jira story. Claude analyses the story and writes test cases; the
// user reviews, edits, approves or rejects them and exports them to Excel. Nothing runs in Salesforce
// until the user starts the approved cases (through the normal batch runner).

export const CASE_TYPES = ["Positive", "Negative", "Boundary", "Edge case", "Validation", "Permission", "Data integrity", "Integration", "Regression"] as const;
export const CaseType = z.enum(CASE_TYPES);
export type CaseType = z.infer<typeof CaseType>;

export const CASE_PRIORITIES = ["High", "Medium", "Low"] as const;
export const CasePriority = z.enum(CASE_PRIORITIES);

export const REVIEW_STATES = ["Pending", "Approved", "Rejected"] as const;
export const CaseReview = z.enum(REVIEW_STATES);
export type CaseReview = z.infer<typeof CaseReview>;

// Body of POST /generations.
export const StartGenerationRequest = z.object({
  orgId: SlugId,
  project: ProjectName.optional(),
  story: z.object({
    // Jira key, e.g. RMS-142.
    key: z.string().trim().max(40).optional(),
    text: z.string().trim().min(20, "Paste the story with its description and acceptance criteria.").max(60_000),
  }),
});
export type StartGenerationRequest = z.infer<typeof StartGenerationRequest>;

export const GeneratedCase = z.object({
  tcId: z.string(),
  storyId: z.string(),
  module: z.string(),
  scenario: z.string(),
  description: z.string(),
  type: CaseType,
  priority: CasePriority,
  persona: z.string(),
  preconditions: z.string(),
  steps: z.array(z.string()),
  testData: z.string(),
  expected: z.string(),
  // Acceptance criteria / requirement ids this case verifies.
  criteria: z.array(z.string()),
  review: CaseReview,
  // Set when the user changed the case.
  edited: z.boolean().optional(),
});
export type GeneratedCase = z.infer<typeof GeneratedCase>;

// What the user may change on a case (PUT /generations/:id/cases/:tcId).
export const CaseUpdate = z.object({
  module: z.string().trim().max(80).optional(),
  scenario: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(2000).optional(),
  type: CaseType.optional(),
  priority: CasePriority.optional(),
  persona: z.string().trim().max(80).optional(),
  preconditions: z.string().trim().max(3000).optional(),
  steps: z.array(z.string().trim().min(1).max(1000)).min(1).max(40).optional(),
  testData: z.string().trim().max(3000).optional(),
  expected: z.string().trim().min(1).max(3000).optional(),
  review: CaseReview.optional(),
});
export type CaseUpdate = z.infer<typeof CaseUpdate>;

export const GenerationStatus = z.enum(["running", "completed", "error"]);

export const Generation = z.object({
  id: z.string(),
  orgId: SlugId,
  orgName: z.string(),
  project: z.string().optional(),
  storyKey: z.string(),
  status: GenerationStatus,
  createdAt: z.string(),
  criteria: z.array(z.object({ id: z.string(), text: z.string() })),
  cases: z.array(GeneratedCase),
  // Criteria no case verifies, computed from the cases' links, plus gaps Claude reported.
  uncovered: z.array(z.string()),
  gaps: z.array(z.string()),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  affectedAreas: z.array(z.string()),
  summary: z.string().optional(),
  log: z.array(z.string()),
  error: z.string().optional(),
});
export type Generation = z.infer<typeof Generation>;
