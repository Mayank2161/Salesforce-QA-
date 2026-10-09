import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SlugId } from "@sfqa/shared";
import { ConfigError } from "./orgs.ts";

// External systems a test may call with call_api (config/apis.json), for example the ERP or middleware
// a Salesforce integration talks to. Only these base URLs can be called; secrets stay in .env and are
// referenced as ${NAME} in header values, so Claude never sees them.
export const ExternalApi = z.object({
  name: SlugId.refine((n) => n !== "salesforce", '"salesforce" is reserved for the org itself'),
  description: z.string().max(300).optional(),
  baseUrl: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), z.string()).default({}),
  // Without it only GET requests are allowed.
  allowWrite: z.boolean().default(false),
  // Org ids it applies to; all orgs when omitted.
  orgs: z.array(SlugId).optional(),
});
export type ExternalApi = z.infer<typeof ExternalApi>;

const ApisConfig = z.object({ apis: z.array(ExternalApi) }).refine(
  (c) => new Set(c.apis.map((a) => a.name)).size === c.apis.length,
  { message: "API names must be unique", path: ["apis"] },
);

// Read on every run so edits apply without a restart. A missing file means no external APIs.
export async function loadExternalApis(path: string, orgId?: string): Promise<ExternalApi[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = ApisConfig.safeParse(json);
  if (!result.success) throw new ConfigError(`${path} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data.apis.filter((a) => !orgId || !a.orgs || a.orgs.includes(orgId));
}

// "Bearer ${ERP_TOKEN}" -> "Bearer abc..." from the server's environment (.env).
export function resolveHeaders(headers: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, key: string) => {
      const v = env[key];
      if (v === undefined) throw new Error(`Header ${name} needs ${key}, which is not set in .env.`);
      return v;
    });
  }
  return out;
}
