import { z } from "zod";

const Env = z.object({
  AGENT_TOKEN: z.string().min(16, "AGENT_TOKEN must be at least 16 characters (set it in .env)"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  // Not used until Phase 2.
  ANTHROPIC_API_KEY: z.string().optional(),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
