import { z } from "zod";
import { BugSeverity, StepStatus, Verdict } from "@sfqa/shared";

// What Claude reports through the QA tools (record_step, report_bug, finish_test).
// Shared by the QA MCP server (tool input schemas) and the agent server (validation).

const text = (max: number) => z.string().trim().min(1).max(max);
const screenshotName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(png|jpe?g)$/, "a bare file name like 03_save_toast.png");

export const StepReportShape = {
  n: z.union([z.string(), z.number()]).describe('Step number as written in the test case, e.g. "3" or "5a"'),
  action: text(500).describe("What the step does, in the test case's words"),
  status: StepStatus.describe("PASS, FAIL, BLOCKED, or N/A"),
  result: text(2000).describe("Actual result observed: concrete values, toasts, errors"),
  screenshot: screenshotName.optional().describe("File name passed to browser_take_screenshot for this step"),
  caption: z.string().max(200).optional().describe("Short caption for the screenshot"),
};
export const StepReport = z.object(StepReportShape);
export type StepReport = z.infer<typeof StepReport>;

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
  screenshots: z.array(z.object({ file: screenshotName, caption: z.string().max(200) })).default([]),
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

export const ListTestDataShape = {
  sobject: sobjectName.optional().describe("Only records of this object"),
};
export const ListTestData = z.object(ListTestDataShape);
export type ListTestData = z.infer<typeof ListTestData>;

export type ReportKind = "step" | "bug" | "finish" | "query" | "create" | "update" | "testdata";
export const REPORT_SCHEMAS = {
  step: StepReport,
  bug: BugReport,
  finish: FinishReport,
  query: Query,
  create: Create,
  update: Update,
  testdata: ListTestData,
} as const;
