// One persona's browser for Claude, served over MCP (stdio): every standard Playwright MCP tool
// (browser_snapshot, browser_click, ...) plus run_steps, which performs a batch of generic actions
// (actions.ts) on the same page in one call. Claude still decides every step and judges every
// result; run_steps only saves a round trip per click. Configured through env SFQA_BROWSER (JSON).
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import { RunStepsInput, formatBatch, runSteps } from "./actions.ts";

export interface BrowserMcpConfig {
  channel: string;
  headless: boolean;
  storageState: string;
  outputDir: string;
  viewport: { width: number; height: number };
  // Fast execution: Claude starts before Login As has finished; wait for the session file.
  waitForStorageState?: boolean;
  // Org origin that org-relative URLs (/lightning/...) resolve against before the first page load.
  baseUrl?: string;
  // Audit trail of every run_steps call (input and result), kept with the run.
  stepsLog?: string;
}

export const RUN_STEPS_DESCRIPTION =
  "Perform several browser actions you have already decided on, in one call, on the current page: navigate, click, fill, select, " +
  "lookup, check, press, upload, waits (waitFor, waitForText, waitForToast, waitForLoad), reads (getText, getField, listOptions), " +
  "checks (verifyText, verifyField, verifyVisible) and screenshot (saved as evidence, not returned as an image). " +
  "Each action waits for Salesforce to finish loading. Address elements by visible label/role/text (or a ref from browser_snapshot). " +
  "Stops at the first step it cannot perform or that does not match, and reports what the page shows (toasts, errors, dialogs). " +
  "Do NOT batch steps whose next action depends on what the previous one shows; use the single browser_* tools then.";

const config = JSON.parse(process.env.SFQA_BROWSER ?? "null") as BrowserMcpConfig | null;
if (!config) {
  console.error("browser-mcp: SFQA_BROWSER is required");
  process.exit(1);
}

// Playwright MCP ships its own Playwright build; the browser must come from that same build so the
// MCP tools accept our context and snapshot refs (aria-ref=e12) resolve in both.
const mcpRequire = createRequire(createRequire(import.meta.url).resolve("@playwright/mcp"));
const { createConnection } = mcpRequire("@playwright/mcp") as {
  createConnection(config: object, contextGetter: () => Promise<BrowserContext>): Promise<{ connect(t: unknown): Promise<void> }>;
};
const { chromium } = mcpRequire("playwright-core") as typeof import("playwright");

let context: BrowserContext | undefined;
// The login session file, once Login As has written it (fast execution starts Claude earlier).
async function storageStateReady(file: string): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  // Complete JSON only: the runner may still be writing the file.
  const ready = async () => {
    try {
      JSON.parse(await readFile(file, "utf8"));
      return true;
    } catch {
      return false;
    }
  };
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("The persona login did not finish in time.");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  if (config!.waitForStorageState) await storageStateReady(config!.storageState);
  const browser = await chromium.launch({ channel: config!.channel === "chromium" ? undefined : config!.channel, headless: config!.headless });
  context = await browser.newContext({ storageState: config!.storageState, viewport: config!.viewport });
  return context;
}

const playwright = await createConnection({
  browser: { isolated: false },
  outputDir: config.outputDir,
  // Generated code in every response is noise for a tester; the action result is enough.
  codegen: "none",
}, getContext);
const [inner, outer] = InMemoryTransport.createLinkedPair();
await playwright.connect(inner);
const client = new Client({ name: "sfqa-browser", version: "1.0.0" });
await client.connect(outer);

// The page Playwright MCP is working on (its current tab).
async function currentPage(): Promise<Page> {
  const pages = (await getContext()).pages();
  if (pages.length === 1) return pages[0]!;
  if (pages.length === 0) return (await getContext()).newPage();
  const list = await client.callTool({ name: "browser_tabs", arguments: { action: "list" } });
  const text = (list.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  const current = /- (\d+): \(current\)/.exec(text)?.[1];
  return pages[Number(current ?? pages.length - 1)] ?? pages.at(-1)!;
}

const server = new Server({ name: "browser", version: "1.0.0" }, { capabilities: { tools: {} } });
const runStepsSchema = z.toJSONSchema(RunStepsInput, { io: "input" });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await client.listTools();
  return { tools: [...tools, { name: "run_steps", description: RUN_STEPS_DESCRIPTION, inputSchema: runStepsSchema as { type: "object" } }] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "run_steps") {
    return client.callTool(req.params, undefined, { timeout: 10 * 60_000 });
  }
  const parsed = RunStepsInput.safeParse(req.params.arguments);
  if (!parsed.success) return { content: [{ type: "text", text: `Invalid run_steps input:\n${z.prettifyError(parsed.error)}` }], isError: true };
  try {
    // Screenshot file names are saved relative to the working folder, like browser_take_screenshot.
    const result = await runSteps(await currentPage(), parsed.data, process.cwd(), { baseUrl: config.baseUrl });
    const failed = result.outcomes.some((o) => o.status === "error");
    const text = formatBatch(result);
    if (config.stepsLog) await appendFile(config.stepsLog, `--- ${new Date().toISOString()}
${JSON.stringify(parsed.data.steps)}
${text}

`).catch(() => undefined);
    return { content: [{ type: "text", text }], isError: failed };
  } catch (err) {
    return { content: [{ type: "text", text: `run_steps failed: ${(err as Error).message}. Continue with the normal browser tools (browser_snapshot first).` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await context?.browser()?.close().catch(() => undefined);
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
