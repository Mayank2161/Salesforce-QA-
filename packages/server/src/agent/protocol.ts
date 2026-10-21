import { z } from "zod";
import { BugSeverity, CasePriority, CaseType, ReviewVerdict, StepStatus, Verdict } from "@sfqa/shared";

// What Claude reports through the QA tools (record_step, report_bug, finish_test).
// Shared by the QA MCP server (tool input schemas) and the agent server (validation).

const text = (max: number) => z.string().trim().min(1).max(max);
const screenshotName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(png|jpe?g)$/, "a bare file name like 03_save_toast.png");
// Evidence files written by call_api (request and response), e.g. api_02_get_account.json.
export const API_EVIDENCE = /^api_\d{2,3}_[a-z0-9_-]{1,80}\.json$/;
const apiEvidenceName = z.string().regex(API_EVIDENCE, "an evidence file name returned by call_api, like api_02_get_account.json");

export const StepReportShape = {
  n: z.union([z.string(), z.number()]).describe('Step number as written in the test case, e.g. "3" or "5a"'),
  action: text(500).describe("What the step does, in the test case's words"),
  status: StepStatus.describe("PASS, FAIL, BLOCKED, or N/A"),
  result: text(2000).describe("Actual result observed: concrete values, toasts, errors"),
  screenshot: screenshotName.optional().describe("File name passed to browser_take_screenshot for this step"),
  caption: z.string().max(200).optional().describe("Short caption for the screenshot"),
  apiEvidence: z.array(apiEvidenceName).max(10).optional().describe("Evidence files returned by call_api for this step (an API step needs no screenshot)"),
  persona: z.string().max(80).optional().describe("In a multi-persona test: the persona who performed this step"),
};
export const StepReport = z.object(StepReportShape);
export type StepReport = z.infer<typeof StepReport>;

// record_steps (fast execution): several consecutive steps, each exactly like one record_step.
export const StepsReportShape = {
  steps: z.array(StepReport).min(1).max(20).describe("Consecutive steps in test case order, each with its own screenshot"),
};
export const StepsReport = z.object(StepsReportShape);
export type StepsReport = z.infer<typeof StepsReport>;

export const BugReportShape = {
  title: text(200).describe("One-line bug title"),
  severity: BugSeverity.describe("Critical, High, Medium, or Low"),
  priority: z.string().max(10).optional().describe("P1-P4"),
  type: z.string().max(80).optional().describe('e.g. "Functional", "Validation", "UI", "Requirement gap"'),
  module: z.string().max(80).optional().describe("Salesforce object/area, e.g. Account, Opportunity"),
  stepsToReproduce: z.array(text(500)).min(1).describe("Numbered steps to reproduce"),
  expected: text(2000),
  actual: text(2000),
  impact: z.string().max(1000).optional(),
  record: z.string().max(200).optional().describe("Record used, e.g. Test Account (001...)"),
  screenshots: z.array(z.object({ file: z.union([screenshotName, apiEvidenceName]), caption: z.string().max(200) })).default([])
    .describe("Screenshots (or call_api evidence files) showing the defect"),
  existingBugId: z.string().regex(/^BUG-\d{3,}$/).optional().describe("Set if this is the same as a known bug, to record a reproduction instead of a new bug"),
};
export const BugReport = z.object(BugReportShape);
export type BugReport = z.infer<typeof BugReport>;

export const FinishReportShape = {
  status: Verdict.describe("Overall test result: PASS, FAIL, or BLOCKED"),
  testCaseId: z.string().max(60).optional().describe("Test case ID from the test case, e.g. TC_008"),
  title: text(300).describe("Test case title"),
  module: z.string().max(80).optional(),
  sprint: z.string().max(80).optional(),
  story: z.string().max(300).optional(),
  type: z.string().max(80).optional().describe("Positive / Negative / ..."),
  priority: z.string().max(40).optional(),
  precondition: z.string().max(1000).optional(),
  record: z.string().max(200).optional(),
  expected: text(2000).describe("Overall expected result"),
  actual: text(2000).describe("Overall actual result"),
  remarks: z.string().max(1000).optional().describe("Deviations, notes, linked bug IDs"),
};
export const FinishReport = z.object(FinishReportShape);
export type FinishReport = z.infer<typeof FinishReport>;

// --- Test data setup (through the org admin's API access) ---------------------------

const sobjectName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe('API name, e.g. "Account", "Opportunity", "Budget__c"');
const recordId = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/).describe("Salesforce record Id");
const fieldValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Field API names to values, e.g. {"Name": "Shooting Store", "OwnerId": "005..."}');

export const QueryShape = {
  soql: z.string().trim().min(1).max(4000).describe("One SOQL SELECT. Use it to find existing records and Ids (users, accounts, picklist-bearing records)."),
};
export const Query = z.object(QueryShape);
export type Query = z.infer<typeof Query>;

export const CreateShape = {
  sobject: sobjectName,
  fields: fieldValues,
  purpose: text(300).describe('Why this record is needed, e.g. "Precondition: active Account for UAT_021"'),
};
export const Create = z.object(CreateShape);
export type Create = z.infer<typeof Create>;

export const UpdateShape = {
  sobject: sobjectName,
  id: recordId,
  fields: fieldValues,
  reason: text(300),
};
export const Update = z.object(UpdateShape);
export type Update = z.infer<typeof Update>;

// --- API checks (call_api) ---------------------------------------------------------------

export const CallApiShape = {
  target: z.string().trim().min(1).max(64).describe('"salesforce" for the org\'s own REST API, or the name of a configured external API'),
  method: z.enum(["GET", "POST", "PUT", "PATCH"]).default("GET"),
  path: z.string().trim().min(1).max(2000).describe('Path after the base URL, starting with "/", e.g. "/services/data/v62.0/sobjects/Account/001..." or "/accounts?id=42"'),
  body: z.unknown().optional().describe("JSON request body for POST/PUT/PATCH"),
  as: z.string().max(80).optional().describe('Salesforce only: "admin" (default) or a persona name of this run, to call the API with that user\'s own access'),
  purpose: text(300).describe("What this call checks, e.g. \"Account synced to ERP with status Active\""),
};
export const CallApi = z.object(CallApiShape);
export type CallApi = z.infer<typeof CallApi>;

export const ListTestDataShape = {
  sobject: sobjectName.optional().describe("Only records of this object"),
};
export const ListTestData = z.object(ListTestDataShape);
export type ListTestData = z.infer<typeof ListTestData>;

// --- Test case review against a requirements document (record_requirements, review_test_case, finish_review) ---

const requirementId = z.string().trim().min(1).max(40);

export const RequirementsReportShape = {
  requirements: z.array(z.object({
    id: requirementId.describe('The ID used in the document (e.g. "BR-04", "RMS 14", "FR 3.2"); if it has none, "REQ-001", "REQ-002", ... in document order'),
    title: text(200).describe("Short name of the requirement"),
    detail: z.string().max(1500).optional().describe("What it requires, in the document's terms: rules, values, who can do what"),
    module: z.string().max(80).optional().describe("Salesforce object/area, e.g. Account"),
    priority: z.string().max(40).optional(),
    source: z.string().max(120).optional().describe('Where it is in the document, e.g. "Section 3.2" or "Page 4"'),
  })).min(1).max(400),
};
export const RequirementsReport = z.object(RequirementsReportShape);
export type RequirementsReport = z.infer<typeof RequirementsReport>;

export const REVIEW_ISSUE_TYPES = [
  "Wrong expected result", "Missing or wrong step", "Wrong precondition or data", "Wrong persona or access",
  "Contradicts requirement", "Ambiguous", "Not in requirements", "Other",
] as const;

export const VerdictReportShape = {
  tcId: z.string().trim().min(1).max(60).describe("TC ID exactly as listed"),
  verdict: ReviewVerdict.describe("Correct, Needs update, Incorrect, or Not traceable"),
  requirementIds: z.array(requirementId).default([]).describe("Requirements this test case verifies (IDs from record_requirements)"),
  issues: z.array(z.object({
    type: z.enum(REVIEW_ISSUE_TYPES),
    detail: text(1000).describe("What is wrong, quoting the requirement and the test case"),
  })).default([]),
  summary: text(600).describe("One or two plain sentences a manager can read: why this verdict"),
  suggestedSteps: z.string().max(4000).optional().describe("Corrected steps, when the steps need changing"),
  suggestedExpected: z.string().max(2000).optional().describe("Corrected expected result, when it needs changing"),
};
export const VerdictReport = z.object(VerdictReportShape);
export type VerdictReport = z.infer<typeof VerdictReport>;

export const FinishReviewShape = {
  summary: text(1500).describe("Overall assessment for a manager in 2-4 sentences: how sound the test cases are and the biggest gaps"),
  gaps: z.array(z.object({
    requirementIds: z.array(requirementId).min(1),
    gap: text(600).describe("What the requirement needs that no test case checks"),
    suggestedTestCase: z.object({
      title: text(200),
      type: z.string().max(40).optional().describe("Positive / Negative"),
      priority: z.string().max(40).optional(),
      persona: z.string().max(80).optional(),
      steps: text(3000),
      expected: text(1500),
    }),
  })).max(200).default([]),
  risks: z.array(text(500)).max(20).default([]).describe("Ambiguities or contradictions in the requirements themselves"),
};
export const FinishReview = z.object(FinishReviewShape);
export type FinishReview = z.infer<typeof FinishReview>;

// --- Test cases from a Jira story (record_criteria, add_test_cases, finish_generation) ---

const criterionId = z.string().trim().min(1).max(40);

export const CriteriaReportShape = {
  criteria: z.array(z.object({
    id: criterionId.describe('"AC1", "AC2", ... for acceptance criteria in story order; "REQ1", ... for other requirements in the description'),
    text: text(800).describe("The criterion or requirement in the story's words"),
  })).min(1).max(100),
};
export const CriteriaReport = z.object(CriteriaReportShape);
export type CriteriaReport = z.infer<typeof CriteriaReport>;

export const GeneratedCaseShape = z.object({
  module: z.string().trim().max(80).describe("Salesforce object or area, e.g. Account, Opportunity"),
  scenario: text(300).describe("Short scenario title"),
  description: text(1500).describe("What this case verifies and why"),
  type: CaseType.describe("Positive, Negative, Boundary, Edge case, Validation, Permission, Data integrity, Integration or Regression"),
  priority: CasePriority,
  persona: z.string().trim().max(80).describe("Exact persona name from the list, or the role the story names"),
  preconditions: z.string().trim().max(3000).describe("State and data that must exist before step 1"),
  steps: z.array(text(1000)).min(1).max(40).describe("Numbered steps in order, one action each, without the numbers"),
  testData: z.string().trim().max(3000).describe("Concrete values to use (field values, record names, file names)"),
  expected: text(3000).describe("Independently verifiable expected result: exact messages, values, states"),
  criteria: z.array(criterionId).min(1).max(20).describe("Criterion/requirement ids from record_criteria this case verifies"),
});

export const CasesReportShape = {
  cases: z.array(GeneratedCaseShape).min(1).max(15),
};
export const CasesReport = z.object(CasesReportShape);
export type CasesReport = z.infer<typeof CasesReport>;

export const FinishGenerationShape = {
  summary: text(1500).describe("2-4 sentences: what the story changes and how the test cases cover it"),
  gaps: z.array(text(600)).max(50).default([]).describe("Requirements that cannot be tested as written, or missing information"),
  assumptions: z.array(text(600)).max(50).default([]).describe("Assumptions made where the story is silent"),
  questions: z.array(text(600)).max(50).default([]).describe("Questions for the product owner or business analyst"),
  affectedAreas: z.array(text(300)).max(50).default([]).describe("Related modules, objects, fields, automation, reports or integrations that may be affected"),
};
export const FinishGeneration = z.object(FinishGenerationShape);
export type FinishGeneration = z.infer<typeof FinishGeneration>;

export type ReportKind = "step" | "steps" | "bug" | "finish" | "query" | "create" | "update" | "testdata" | "api" | "requirements" | "verdict" | "reviewDone" | "criteria" | "cases" | "generationDone";
export const REPORT_SCHEMAS = {
  api: CallApi,
  step: StepReport,
  steps: StepsReport,
  bug: BugReport,
  finish: FinishReport,
  query: Query,
  create: Create,
  update: Update,
  testdata: ListTestData,
  requirements: RequirementsReport,
  verdict: VerdictReport,
  reviewDone: FinishReview,
  criteria: CriteriaReport,
  cases: CasesReport,
  generationDone: FinishGeneration,
} as const;
