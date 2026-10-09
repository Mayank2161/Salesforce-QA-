import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHeaders, type ExternalApi } from "../config/apis.ts";
import type { CallApi } from "./protocol.ts";

// call_api: lets a test check what the UI cannot show, through the org's REST API or a configured
// external system. Every call is saved as an evidence file next to the run's screenshots.

export interface ApiCallContext {
  // Base URL and Authorization header for Salesforce, as the admin or as one of the run's personas.
  salesforce(as: string | undefined): Promise<{ baseUrl: string; authorization: string }>;
  externalApis: ExternalApi[];
  evidenceDir: string;
  nextIndex(): number;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface ApiCallResult {
  file: string;
  status: number;
  message: string;
}

const MAX_BODY_FOR_CLAUDE = 8_000;
const MAX_BODY_SAVED = 200_000;
// Salesforce writes are limited to Apex REST: that is how external systems push data in.
const SF_READ_PATH = /^\/services\/(data|apexrest)\//;
const SF_WRITE_PATH = /^\/services\/apexrest\//;

export async function performApiCall(ctx: ApiCallContext, r: CallApi): Promise<ApiCallResult> {
  if (!r.path.startsWith("/") || /(^|\/)\.\.(\/|$)|\/\/|\\/.test(r.path)) {
    throw new Error('The path must start with "/" and contain no "..", "//" or "\\".');
  }
  let url: URL;
  let headers: Record<string, string>;
  let targetLabel: string;
  if (r.target === "salesforce") {
    if (!SF_READ_PATH.test(r.path)) throw new Error("Salesforce calls must use the REST API: paths starting with /services/data/ or /services/apexrest/.");
    if (r.method !== "GET" && !SF_WRITE_PATH.test(r.path)) {
      throw new Error("Only GET is allowed on /services/data/. To create or change test data use create_record / update_test_record; POST/PUT/PATCH are allowed only to Apex REST endpoints (/services/apexrest/...).");
    }
    const sf = await ctx.salesforce(r.as);
    url = new URL(r.path, sf.baseUrl);
    headers = { Authorization: sf.authorization };
    targetLabel = `salesforce${r.as && r.as.toLowerCase() !== "admin" ? ` as ${r.as}` : " as admin"}`;
  } else {
    const api = ctx.externalApis.find((a) => a.name === r.target);
    if (!api) {
      const names = ["salesforce", ...ctx.externalApis.map((a) => a.name)];
      throw new Error(`Unknown API "${r.target}". Available: ${names.join(", ")}. External systems are added in config/apis.json.`);
    }
    if (r.as) throw new Error('"as" applies only to target "salesforce".');
    if (r.method !== "GET" && !api.allowWrite) throw new Error(`${api.name} is read-only: only GET is allowed (set "allowWrite" in config/apis.json to change that).`);
    const base = new URL(api.baseUrl);
    url = new URL(base.toString().replace(/\/$/, "") + r.path);
    // The path cannot leave the configured base URL.
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, ""))) {
      throw new Error(`The path must stay under ${api.baseUrl}.`);
    }
    headers = resolveHeaders(api.headers, ctx.env);
    targetLabel = api.name;
  }

  const hasBody = r.body !== undefined && r.method !== "GET";
  const started = Date.now();
  let res: Response;
  try {
    res = await (ctx.fetch ?? fetch)(url, {
      method: r.method,
      headers: { Accept: "application/json", ...(hasBody && { "Content-Type": "application/json" }), ...headers },
      ...(hasBody && { body: JSON.stringify(r.body) }),
      // Never follow a redirect elsewhere with the credentials attached.
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    throw new Error(`Could not reach ${url.origin} (${cause}).`, { cause: err });
  }
  const durationMs = Date.now() - started;
  const text = (await res.text()).slice(0, MAX_BODY_SAVED);
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : "";
  } catch {
    // not JSON: kept as text
  }

  const n = ctx.nextIndex();
  const slug = `${r.method}_${r.purpose}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "call";
  const file = `api_${String(n).padStart(2, "0")}_${slug}.json`;
  await writeFile(join(ctx.evidenceDir, file), `${JSON.stringify({
    purpose: r.purpose,
    target: targetLabel,
    request: { method: r.method, url: url.toString(), ...(hasBody && { body: r.body }) },
    response: {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type") ?? "",
      ...(res.headers.get("location") && { location: res.headers.get("location") }),
      body: parsed,
    },
    durationMs,
    at: new Date().toISOString(),
  }, null, 2)}\n`);

  const shown = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 1);
  const body = shown.length > MAX_BODY_FOR_CLAUDE ? `${shown.slice(0, MAX_BODY_FOR_CLAUDE)}\n... (truncated; ${shown.length} characters in total, all saved in the evidence file)` : shown;
  return {
    file,
    status: res.status,
    message: `HTTP ${res.status} ${res.statusText} in ${durationMs} ms from ${r.method} ${url.pathname}${url.search}. Evidence saved as ${file} (use it in record_step "apiEvidence").\n${body || "(empty body)"}`,
  };
}

// One-line description for the run log and the panel.
export function describeApiCall(r: CallApi, result: ApiCallResult): string {
  return `API ${r.method} ${r.target}${r.as ? ` (as ${r.as})` : ""} ${r.path.split("?")[0]!.slice(0, 120)} → ${result.status}`;
}
