import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

export interface ClaudeSettings {
  // Path or command name of the Claude Code CLI.
  command: string;
  // "sonnet" by default: stretches the Team seat allowance further than Opus.
  model: string;
  maxTurns: number;
  timeoutMs: number;
}

export function claudeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeSettings {
  return {
    command: env.CLAUDE_PATH || "claude",
    model: env.CLAUDE_MODEL || "sonnet",
    maxTurns: Number(env.CLAUDE_MAX_TURNS) || 150,
    timeoutMs: (Number(env.RUN_TIMEOUT_MINUTES) || 30) * 60_000,
  };
}

export interface ClaudeRunResult {
  ok: boolean;
  error?: string;
  turns?: number;
  durationMs?: number;
}

// The child must use the signed-in Claude Code account (the org's Team seat), never API billing,
// and must not inherit variables Claude Code sets for its own nested sessions.
export function claudeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID)/.test(name)) continue;
    child[name] = value;
  }
  return child;
}

export function claudeArgs(settings: ClaudeSettings, mcpConfigPath: string): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", settings.model,
    "--max-turns", String(settings.maxTurns),
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    // No built-in tools (shell, file edits): only the browser and QA MCP tools below.
    "--tools", "",
    "--allowedTools", "mcp__playwright", "mcp__qa",
    "--setting-sources", "project",
    "--no-session-persistence",
  ];
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// One-line description of a tool call for the live log.
export function describeToolUse(name: string, input: Record<string, unknown> = {}): string | undefined {
  const tool = name.replace(/^mcp__(playwright|qa)__/, "");
  const target = String(input.element ?? input.url ?? input.filename ?? input.text ?? "").slice(0, 120);
  switch (tool) {
    case "browser_snapshot":
    case "browser_wait_for":
      return undefined; // too chatty for the panel
    case "record_step":
      return `Recording step ${String(input.n)}: ${String(input.status)}`;
    case "report_bug":
      return `Filing bug: ${String(input.title ?? "").slice(0, 120)}`;
    case "finish_test":
      return `Finishing test: ${String(input.status)}`;
    case "query_records":
      return `Looking up data: ${String(input.soql ?? "").slice(0, 140)}`;
    case "list_test_data":
      return "Checking test data from earlier runs";
    case "create_record":
    case "update_test_record":
      return undefined; // the server logs the result with the record Id
    default:
      return target ? `${tool.replace(/^browser_/, "")}: ${target}` : tool.replace(/^browser_/, "");
  }
}

// Runs headless Claude Code with the prompt on stdin and streams its activity to onLog.
export function runClaude(opts: {
  settings: ClaudeSettings;
  cwd: string;
  mcpConfigPath: string;
  prompt: string;
  onLog: (level: "info" | "warn" | "error", message: string) => void;
}): Promise<ClaudeRunResult> {
  const { settings, onLog } = opts;
  return new Promise((resolve) => {
    const child = spawn(settings.command, claudeArgs(settings, opts.mcpConfigPath), {
      cwd: opts.cwd,
      env: claudeChildEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let result: ClaudeRunResult | undefined;
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      onLog("error", `Run exceeded ${Math.round(settings.timeoutMs / 60_000)} minutes; stopping Claude.`);
      killTree(child.pid);
    }, settings.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Could not start Claude Code ("${settings.command}"): ${err.message}. Is Claude Code installed and signed in?` });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "system" && msg.subtype === "init") {
        for (const s of (msg.mcp_servers as { name: string; status: string }[] | undefined) ?? []) {
          if (s.status !== "connected") onLog("error", `Tool server "${s.name}" failed to start (${s.status}).`);
        }
        onLog("info", `Claude (${String(msg.model ?? settings.model)}) started on your Claude Code login.`);
      } else if (msg.type === "assistant") {
        const content = ((msg.message as { content?: ContentBlock[] })?.content) ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) onLog("info", block.text.trim().slice(0, 300));
          if (block.type === "tool_use" && block.name) {
            const line = describeToolUse(block.name, block.input);
            if (line) onLog("info", line);
          }
        }
      } else if (msg.type === "result") {
        const isError = Boolean(msg.is_error) || msg.subtype !== "success";
        result = {
          ok: !isError,
          turns: msg.num_turns as number | undefined,
          durationMs: msg.duration_ms as number | undefined,
          ...(isError && { error: describeResultError(msg) }),
        };
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, error: `Timed out after ${Math.round(settings.timeoutMs / 60_000)} minutes.` });
      if (result) return resolve(result);
      const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      resolve({ ok: false, error: `Claude Code exited (code ${code}) without a result.${tail ? ` ${tail}` : ""}` });
    });

    child.stdin.end(opts.prompt);
  });
}

function describeResultError(msg: Record<string, unknown>): string {
  if (msg.subtype === "error_max_turns") return "Claude reached the maximum number of turns before finishing.";
  const text = String(msg.result ?? msg.subtype ?? "unknown error");
  if (/usage limit|rate limit/i.test(text)) return `Claude usage limit reached for your seat: ${text}`;
  return `Claude reported an error: ${text.slice(0, 500)}`;
}

// Stops Claude and the tool servers and browser it started.
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid, "SIGKILL");
}
