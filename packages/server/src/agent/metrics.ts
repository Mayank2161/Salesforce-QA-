import type { RunMetrics } from "@sfqa/shared";

// What one Claude Code session cost, read from its stream-json output.
export type SessionMetrics = Omit<RunMetrics, "mode" | "totalMs" | "screenshots">;

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | { type: string; text?: string }[];
}

// Browser tools that read the page instead of acting on it.
const READS = new Set(["browser_snapshot", "browser_find", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_network_request", "browser_tabs"]);

const toolName = (name: string) => name.replace(/^mcp__[^_]+(?:_\d+)?__/, "");

export class MetricsCollector {
  #names = new Map<string, string>();
  #pending = new Map<string, string>();
  #m: SessionMetrics = {
    toolCalls: {}, browserActions: 0, batches: 0, batchSteps: 0, batchFallbacks: 0, snapshots: 0,
    imagesToClaude: 0, fixedWaits: 0, fixedWaitSeconds: 0, toolResultChars: 0, snapshotChars: 0,
  };

  onMessage(msg: Record<string, unknown>): void {
    const content = ((msg.message as { content?: Block[] } | undefined)?.content) ?? [];
    if (msg.type === "assistant") {
      for (const b of content) if (b.type === "tool_use" && b.id && b.name) this.#toolUse(b.id, toolName(b.name), b.input ?? {});
    } else if (msg.type === "user" && Array.isArray(content)) {
      for (const b of content) if (b.type === "tool_result") this.#toolResult(b);
    } else if (msg.type === "result") {
      const u = msg.usage as Record<string, number> | undefined;
      this.#m.turns = msg.num_turns as number | undefined;
      this.#m.claudeMs = msg.duration_ms as number | undefined;
      if (typeof msg.total_cost_usd === "number") this.#m.costUsd = msg.total_cost_usd;
      if (u) {
        this.#m.tokens = {
          input: u.input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0,
        };
      }
    }
  }

  // Tools called but not answered yet (what Claude is waiting for).
  pendingTools(): string[] {
    return [...this.#pending.values()];
  }

  get metrics(): SessionMetrics {
    return structuredClone(this.#m);
  }

  #toolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.#names.set(id, name);
    this.#pending.set(id, name);
    const m = this.#m;
    m.toolCalls[name] = (m.toolCalls[name] ?? 0) + 1;
    if (name === "browser_snapshot") m.snapshots++;
    if (name === "run_steps") {
      const steps = Array.isArray(input.steps) ? input.steps.length : 0;
      m.batches++;
      m.batchSteps += steps;
      m.browserActions += steps;
    } else if (name.startsWith("browser_") && !READS.has(name)) {
      m.browserActions++;
    }
    if (name === "browser_wait_for" && typeof input.time === "number") {
      m.fixedWaits++;
      m.fixedWaitSeconds += input.time;
    }
  }

  #toolResult(b: Block): void {
    const name = b.tool_use_id ? this.#names.get(b.tool_use_id) : undefined;
    if (b.tool_use_id) this.#pending.delete(b.tool_use_id);
    const parts = typeof b.content === "string" ? [{ type: "text", text: b.content }] : (b.content ?? []);
    let chars = 0;
    for (const p of parts) {
      if (p.type === "image") this.#m.imagesToClaude++;
      else chars += p.text?.length ?? 0;
    }
    this.#m.toolResultChars += chars;
    if (name === "browser_snapshot") this.#m.snapshotChars += chars;
    if (name === "run_steps" && b.is_error) this.#m.batchFallbacks++;
  }
}
