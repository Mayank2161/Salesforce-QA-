import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const ORGS_CONFIG_PATH = join(REPO_ROOT, "config", "orgs.json");
// External systems tests may call (optional; see config/apis.example.json).
export const APIS_CONFIG_PATH = join(REPO_ROOT, "config", "apis.json");
export const AUTH_DIR = join(REPO_ROOT, "auth");
export const RUNS_DIR = join(REPO_ROOT, "runs");
// Reports, bugs and screenshots, laid out like the RMS QA project.
export const QA_DIR = join(REPO_ROOT, "qa");
export const QA_TEMPLATES_DIR = resolve(import.meta.dirname, "../templates/qa");
export const QA_MCP_SCRIPT = resolve(import.meta.dirname, "agent/qa-mcp.ts");
// Each persona's browser in hybrid execution: Playwright MCP tools plus run_steps.
export const BROWSER_MCP_SCRIPT = resolve(import.meta.dirname, "agent/browser-mcp.ts");
// Tools for turning a Jira story into test cases (no browser, no Salesforce).
export const STORY_MCP_SCRIPT = resolve(import.meta.dirname, "agent/story-mcp.ts");
export const REVIEW_MCP_SCRIPT = resolve(import.meta.dirname, "agent/review-mcp.ts");
export const PLAYWRIGHT_MCP_CLI = join(REPO_ROOT, "node_modules", "@playwright", "mcp", "cli.js");
