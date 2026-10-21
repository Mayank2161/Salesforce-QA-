// Tools for turning a Jira story into test cases, served over MCP (stdio) for one generation. Claude
// gets no browser and no Salesforce access here: it only reads the story and writes test cases.
// Each tool forwards its input to the local agent server, which validates and stores it.
// Configured through env: SFQA_URL, SFQA_RUN_ID, SFQA_RUN_KEY.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CasesReportShape, CriteriaReportShape, FinishGenerationShape, type ReportKind } from "./protocol.ts";

const { SFQA_URL, SFQA_RUN_ID, SFQA_RUN_KEY } = process.env;
if (!SFQA_URL || !SFQA_RUN_ID || !SFQA_RUN_KEY) {
  console.error("story-mcp: SFQA_URL, SFQA_RUN_ID and SFQA_RUN_KEY are required");
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

server.registerTool("record_criteria", {
  description: "Record the story's acceptance criteria and other testable requirements, before writing any test case. Call again to add more; ids must be unique.",
  inputSchema: CriteriaReportShape,
}, (input) => report("criteria", input));

server.registerTool("add_test_cases", {
  description: "Add up to 15 test cases. Call as many times as needed. Each case links to the criteria it verifies. Duplicates of an existing case are rejected.",
  inputSchema: CasesReportShape,
}, (input) => report("cases", input));

server.registerTool("finish_generation", {
  description: "Call exactly once at the end: summary, gaps, assumptions, questions for the business and affected areas.",
  inputSchema: FinishGenerationShape,
}, (input) => report("generationDone", input));

await server.connect(new StdioServerTransport());
