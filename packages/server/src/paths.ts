import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const ORGS_CONFIG_PATH = join(REPO_ROOT, "config", "orgs.json");
export const AUTH_DIR = join(REPO_ROOT, "auth");
export const RUNS_DIR = join(REPO_ROOT, "runs");
// Reports, bugs and screenshots, laid out like the RMS QA project.
export const QA_DIR = join(REPO_ROOT, "qa");
export const QA_TEMPLATES_DIR = resolve(import.meta.dirname, "../templates/qa");
export const QA_MCP_SCRIPT = resolve(import.meta.dirname, "agent/qa-mcp.ts");
export const PLAYWRIGHT_MCP_CLI = join(REPO_ROOT, "node_modules", "@playwright", "mcp", "cli.js");
