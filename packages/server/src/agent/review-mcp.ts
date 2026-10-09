// Test case review tools for Claude, served over MCP (stdio). Started by Claude Code for one review.
// Each tool forwards its input to the local agent server, which validates it, updates the panel's
// progress and writes the review report. Configured through env: SFQA_URL, SFQA_RUN_ID, SFQA_RUN_KEY.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FinishReviewShape, RequirementsReportShape, VerdictReportShape, type ReportKind } from "./protocol.ts";

const { SFQA_URL, SFQA_RUN_ID, SFQA_RUN_KEY } = process.env;
if (!SFQA_URL || !SFQA_RUN_ID || !SFQA_RUN_KEY) {
  console.error("review-mcp: SFQA_URL, SFQA_RUN_ID and SFQA_RUN_KEY are required");
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

server.registerTool("record_requirements", {
  description:
    "Record the requirements found in the document, before reviewing any test case. " +
    "Call it again to add more if the document is long; IDs must be unique.",
  inputSchema: RequirementsReportShape,
}, (input) => report("requirements", input));

server.registerTool("review_test_case", {
  description: "Record the verdict for one test case. Call once per test case, for every test case listed.",
  inputSchema: VerdictReportShape,
}, (input) => report("verdict", input));

server.registerTool("finish_review", {
  description: "Call exactly once at the end, after every test case has a verdict: the overall summary, requirement gaps with suggested test cases, and risks.",
  inputSchema: FinishReviewShape,
}, (input) => report("reviewDone", input));

await server.connect(new StdioServerTransport());
