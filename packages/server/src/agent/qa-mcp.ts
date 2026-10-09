// QA reporting tools for Claude, served over MCP (stdio). Started by Claude Code for one run.
// Each tool forwards its input to the local agent server, which validates it, updates the panel
// live, and writes the reports. Configured through env: SFQA_URL, SFQA_RUN_ID, SFQA_RUN_KEY.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BugReportShape, CallApiShape, CreateShape, FinishReportShape, ListTestDataShape, QueryShape, StepReportShape, UpdateShape, type ReportKind,
} from "./protocol.ts";

const { SFQA_URL, SFQA_RUN_ID, SFQA_RUN_KEY } = process.env;
if (!SFQA_URL || !SFQA_RUN_ID || !SFQA_RUN_KEY) {
  console.error("qa-mcp: SFQA_URL, SFQA_RUN_ID and SFQA_RUN_KEY are required");
  process.exit(1);
}

async function report(kind: ReportKind, input: unknown) {
  let message: string;
  let isError: boolean;
  try {
    const res = await fetch(`${SFQA_URL}/internal/runs/${SFQA_RUN_ID}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SFQA-Run-Key": SFQA_RUN_KEY! },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    message = body.message ?? `HTTP ${res.status}`;
    isError = !res.ok;
  } catch (err) {
    message = `Could not reach the QA agent server: ${(err as Error).message}`;
    isError = true;
  }
  return { content: [{ type: "text" as const, text: message }], isError };
}

const server = new McpServer({ name: "qa", version: "1.0.0" });

server.registerTool("record_step", {
  description:
    "Record the result of one test step, right after performing it and taking its screenshot with browser_take_screenshot. " +
    "Call once per step, in order.",
  inputSchema: StepReportShape,
}, (input) => report("step", input));

server.registerTool("report_bug", {
  description:
    "File a bug for a FAIL step (application behaves differently from the expected result). " +
    "Set existingBugId instead of filing a duplicate when it matches a known open bug.",
  inputSchema: BugReportShape,
}, (input) => report("bug", input));

// Test data setup. These run with the org admin's access, not as the persona, so use them only to
// prepare preconditions; perform the test steps themselves in the browser.
server.registerTool("list_test_data", {
  description: "List records created for testing by earlier runs in this org (reuse them before creating new ones).",
  inputSchema: ListTestDataShape,
}, (input) => report("testdata", input));

server.registerTool("query_records", {
  description: "Run one read-only SOQL SELECT with admin access to find existing records, user Ids and field values.",
  inputSchema: QueryShape,
}, (input) => report("query", input));

server.registerTool("create_record", {
  description:
    "Create a missing test-data record (precondition) with admin access, e.g. an Account the test needs. " +
    "Create parents first. Never use this to perform the action under test.",
  inputSchema: CreateShape,
}, (input) => report("create", input));

server.registerTool("update_test_record", {
  description: "Change fields on a record created for testing (only records listed by list_test_data), e.g. to assign it to the persona.",
  inputSchema: UpdateShape,
}, (input) => report("update", input));

server.registerTool("call_api", {
  description:
    "Call an API to check what the UI cannot show: the org's Salesforce REST API (records, Apex REST endpoints) or a configured " +
    "external system the org integrates with. Returns the status and response, and saves them as evidence; put the returned " +
    "evidence file name in record_step \"apiEvidence\" (or report_bug \"screenshots\").",
  inputSchema: CallApiShape,
}, (input) => report("api", input));

server.registerTool("finish_test", {
  description: "Call exactly once at the end with the overall result and the test case details.",
  inputSchema: FinishReportShape,
}, (input) => report("finish", input));

await server.connect(new StdioServerTransport());
