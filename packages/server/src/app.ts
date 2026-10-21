import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import {
  CaseUpdate, StartGenerationRequest,
  NewPersona, PROTOCOL_VERSION, ParseSuiteRequest, RunId, RunRequest, SlugId, StartReviewRequest, StartSuiteRequest, detectOrgFromHostname, myDomainOf, toSlug,
} from "@sfqa/shared";
import type { Org, Persona, Run, RunEvent, SalesforceUser } from "@sfqa/shared";
import type { AgentBridge } from "./agent/bridge.ts";
import { ConfigError, loadOrgsConfig, updateOrgsConfig } from "./config/orgs.ts";
import { EVIDENCE_NAME, type QaWorkspace } from "./reports/workspace.ts";
import { PROJECT_SECTIONS, ProjectError, type ProjectStore } from "./projects/store.ts";
import { GenerationError, type GenerationService } from "./generation/service.ts";
import { RunStore } from "./runs/store.ts";
import { SuiteFileError, readRows, toSuite } from "./suites/parse.ts";
import { SuiteStore } from "./suites/store.ts";
import { RequirementsFileError, extractRequirements } from "./reviews/extract.ts";
import type { ReviewService } from "./reviews/service.ts";
import { SalesforceApiError } from "./salesforce/api.ts";
import { listConnections } from "./salesforce/session.ts";
import { bearerToken, isAllowedHost, isAllowedOrigin, redactToken, tokensMatch } from "./api/security.ts";

export interface AppOptions {
  token: string;
  orgsConfigPath: string;
  authDir: string;
  runsDir: string;
  store?: RunStore;
  // Called after a run is queued; the real server hands it to the Playwright runner.
  onRunCreated?: (run: Run) => void;
  // Opens a visible admin login window for the org and resolves once the session is saved.
  connectOrg?: (org: Org) => Promise<void>;
  // Searches the org's active users through the saved admin session.
  searchUsers?: (org: Org, term: string) => Promise<SalesforceUser[]>;
  // Resolves false when Salesforce no longer accepts the org's saved admin session.
  verifyConnection?: (org: Org) => Promise<boolean>;
  // Receives QA tool calls (steps, bugs, finish) from running Claude processes.
  bridge?: AgentBridge;
  // The qa/ reports folder, served read-only behind a secret path key.
  qa?: QaWorkspace;
  // Project folders (QA-Workspace/Projects/<project>/<org>/) for reports and notes.
  projects?: ProjectStore;
  // Test cases generated from pasted Jira stories.
  generations?: GenerationService;
  // Shows a folder in the computer's file manager (Explorer on Windows).
  openFolder?: (path: string) => Promise<void>;
  // Uploaded test-case batches.
  suites?: SuiteStore;
  // Reviews of uploaded test cases against a requirements document (BRD).
  reviews?: ReviewService;
  logger?: boolean;
}

const REPORT_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
};

const PROJECT_ERROR_STATUS: Record<ProjectError["code"], number> = {
  invalid_name: 400, invalid_note: 400, project_exists: 409, folder_exists: 409, unknown_project: 404, unknown_org: 404, unknown_note: 404,
};

// Serves a file below root, or answers 404. Only known report file types, never anything outside root.
async function sendBelow(root: string, rel: string, reply: FastifyReply) {
  const base = resolve(root);
  const file = resolve(base, rel);
  const type = REPORT_CONTENT_TYPES[extname(file).toLowerCase()];
  if (!rel || rel.includes("\0") || !file.startsWith(base + sep) || !type) return reply.code(404).send({ error: "not_found" });
  try {
    const data = await readFile(file);
    return reply.type(type).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").send(data);
  } catch {
    return reply.code(404).send({ error: "not_found" });
  }
}

// Keeps the extension's background worker (and so the panel's live connection) awake during quiet runs.
const HEARTBEAT_MS = 20_000;

const DetectRequest = z.object({ hostname: z.string().min(1).max(253) });

// Salesforce session problems are 409s, never 401: the extension reads 401 as "agent token rejected".
const API_ERROR_STATUS = { not_connected: 409, session_expired: 409, request_failed: 502 } as const;

class HttpError extends Error {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  constructor(statusCode: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.statusCode = statusCode;
    this.body = body;
  }
}

// Evidence files are flat screenshot names (03_save_toast.png), API call records (api_02_get_account.json)
// or run.json; anything else is refused.
const isEvidenceFile = (file: string) => file === "run.json" || EVIDENCE_NAME.test(file);

// /qa/... uses its own secret path key (report pages and their images can't send headers);
// /internal/... is authenticated per run by the agent bridge.
const PUBLIC_ROUTES = new Set(["/health", "/qa/:key/*", "/ws/:key/*", "/internal/runs/:id/:kind"]);

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const store = opts.store ?? new RunStore();
  const suites = opts.suites ?? new SuiteStore(store);
  const app = Fastify({
    logger: opts.logger === false ? false : {
      serializers: { req: (req) => ({ method: req.method, url: redactToken(req.url) }) },
    },
  });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedHost(req.headers.host)) return reply.code(403).send({ error: "forbidden_host" });
    if (!isAllowedOrigin(req.headers.origin)) return reply.code(403).send({ error: "forbidden_origin" });
    if (PUBLIC_ROUTES.has(req.routeOptions.url ?? "")) return;

    // Browsers cannot set headers on a WebSocket handshake, so only upgrades may pass the token in the query.
    const isUpgrade = req.headers.upgrade?.toLowerCase() === "websocket";
    const token = bearerToken(req.headers.authorization) ?? (isUpgrade ? (req.query as { token?: string }).token : undefined);
    if (!tokensMatch(token, opts.token)) return reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send(error.body);
    if (error instanceof ProjectError) return reply.code(PROJECT_ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
    if (error instanceof GenerationError) {
      return reply.code({ busy: 409, running: 409, not_found: 404, unknown_case: 404 }[error.code]).send({ error: error.code, message: error.message });
    }
    if (error instanceof SalesforceApiError) {
      return reply.code(API_ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
    }
    if (error instanceof ConfigError) {
      return reply.code(500).send({ error: "config_error", message: error.message });
    }
    return reply.send(error);
  });

  app.get("/health", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  // --- Reports -------------------------------------------------------------------

  // Unguessable without the agent token, stable across restarts so bookmarked report links keep working.
  const reportKey = createHmac("sha256", opts.token).update("qa-reports").digest("hex").slice(0, 32);

  const workspaceKey = createHmac("sha256", opts.token).update("qa-workspace").digest("hex").slice(0, 32);

  // ?project=<name>&orgId=<org>: that project's reports for that org. ?orgId=<org> alone: the shared
  // qa/ reports, opened filtered to that org so other orgs' runs never mix in.
  app.get<{ Querystring: { project?: string; orgId?: string } }>("/reports/links", async (req, reply) => {
    if (!opts.qa) return reply.code(501).send({ error: "reports_not_available" });
    const { project, orgId } = req.query;
    if (project) {
      if (!opts.projects || !orgId) return reply.code(400).send({ error: "invalid_request", message: "A project link needs orgId." });
      const p = await opts.projects.get(project);
      const org = p.orgs.find((o) => o.orgId === orgId);
      if (!org) throw new ProjectError("unknown_org", `Project "${p.name}" has no folder for this org yet.`);
      const base = `http://${req.headers.host}/ws/${workspaceKey}/Projects/${encodeURIComponent(p.name)}/${encodeURIComponent(org.folder)}`;
      return {
        executionReport: `${base}/${encodeURIComponent("Test Execution Reports")}/Test_Execution_Report.html`,
        bugReport: `${base}/${encodeURIComponent("Bug Reports")}/Bug_Report.html`,
        reviewReport: `http://${req.headers.host}/qa/${reportKey}/reviews/Test_Case_Review.html`,
        scope: { project: p.name, folder: org.folder },
      };
    }
    const base = `http://${req.headers.host}/qa/${reportKey}`;
    const env = orgId ? (await loadOrgsConfig(opts.orgsConfigPath)).orgs.find((o) => o.id === orgId)?.name : undefined;
    const q = env ? `?env=${encodeURIComponent(env)}` : "";
    return {
      executionReport: `${base}/reports/Test_Execution_Report.html${q}`,
      bugReport: `${base}/bugs/Bug_Report.html${q}`,
      reviewReport: `${base}/reviews/Test_Case_Review.html`,
      ...(env && { scope: { org: env } }),
    };
  });

  // The project workspace, served read-only behind its own secret path key.
  app.get<{ Params: { key: string; "*": string } }>("/ws/:key/*", async (req, reply) => {
    if (!opts.projects || !tokensMatch(req.params.key, workspaceKey)) return reply.code(404).send({ error: "not_found" });
    return sendBelow(opts.projects.root, decodeURIComponent(req.params["*"] ?? ""), reply);
  });

  // --- Projects: folders for each project and org, with notes ------------------------------------------

  const projects = () => {
    if (!opts.projects) throw new HttpError(501, { error: "projects_not_available" });
    return opts.projects;
  };
  const NameBody = z.object({ name: z.string().max(200) });
  const OrgBody = z.object({ orgId: SlugId, folder: z.string().max(200).optional() });
  const NoteBody = z.object({ title: z.string().max(500), body: z.string().max(200_000).default("") });
  const OpenBody = z.object({ orgId: SlugId.optional(), section: z.enum(PROJECT_SECTIONS).optional() });
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, { error: "invalid_request", issues: r.error.issues });
    return r.data;
  };

  // --- Test cases from a Jira story ---------------------------------------------------------------------
  // Generation never runs anything in Salesforce. Approved cases are run with the normal batch runner.

  const generations = () => {
    if (!opts.generations) throw new HttpError(501, { error: "generation_not_available" });
    return opts.generations;
  };

  app.post("/generations", async (req, reply) => {
    const body = parse(StartGenerationRequest, req.body);
    const org = await findOrg(body.orgId);
    if (body.project) await projects().get(body.project);
    return reply.code(202).send(await generations().start(org, body));
  });

  app.get<{ Params: { id: string } }>("/generations/:id", async (req, reply) => {
    const gen = await generations().get(req.params.id);
    return gen ?? reply.code(404).send({ error: "not_found" });
  });

  app.put<{ Params: { id: string; tcId: string } }>("/generations/:id/cases/:tcId", async (req) =>
    generations().updateCase(req.params.id, req.params.tcId, parse(CaseUpdate, req.body)));

  app.get<{ Params: { id: string }; Querystring: { approved?: string } }>("/generations/:id/export", async (req, reply) => {
    const { data, fileName } = await generations().exportXlsx(req.params.id, req.query.approved === "1");
    return reply
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${fileName.replace(/[^A-Za-z0-9_.-]/g, "_")}"`)
      .send(Buffer.from(data));
  });

  app.get("/projects", async () => ({ root: projects().root, projects: await projects().list() }));

  app.post("/projects", async (req, reply) => reply.code(201).send(await projects().create(parse(NameBody, req.body).name)));

  // Adds the org's folder to the project (or confirms it is there), creating its three sections.
  app.post<{ Params: { name: string } }>("/projects/:name/orgs", async (req, reply) => {
    const { orgId, folder } = parse(OrgBody, req.body);
    const org = await findOrg(orgId);
    return reply.code(201).send(await projects().addOrg(req.params.name, org, folder));
  });

  app.post<{ Params: { name: string } }>("/projects/:name/open", async (req, reply) => {
    if (!opts.openFolder) return reply.code(501).send({ error: "open_not_available" });
    const { orgId, section } = parse(OpenBody, req.body ?? {});
    const path = await projects().folder(req.params.name, orgId, section);
    await opts.openFolder(path);
    return { path };
  });

  type NoteParams = { name: string; orgId: string; id: string };
  app.get<{ Params: NoteParams }>("/projects/:name/orgs/:orgId/notes", async (req) => ({ notes: await projects().listNotes(req.params.name, req.params.orgId) }));
  app.post<{ Params: NoteParams }>("/projects/:name/orgs/:orgId/notes", async (req, reply) =>
    reply.code(201).send(await projects().createNote(req.params.name, req.params.orgId, parse(NoteBody, req.body))));
  app.put<{ Params: NoteParams }>("/projects/:name/orgs/:orgId/notes/:id", async (req) =>
    projects().updateNote(req.params.name, req.params.orgId, req.params.id, parse(NoteBody, req.body)));
  app.delete<{ Params: NoteParams }>("/projects/:name/orgs/:orgId/notes/:id", async (req, reply) => {
    await projects().deleteNote(req.params.name, req.params.orgId, req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { key: string; "*": string } }>("/qa/:key/*", async (req, reply) => {
    if (!opts.qa || !tokensMatch(req.params.key, reportKey)) return reply.code(404).send({ error: "not_found" });
    return sendBelow(opts.qa.root, decodeURIComponent(req.params["*"] ?? ""), reply);
  });

  // QA tool calls from a run's Claude process (see agent/qa-mcp.ts).
  app.post<{ Params: { id: string; kind: string } }>("/internal/runs/:id/:kind", async (req, reply) => {
    if (!opts.bridge) return reply.code(404).send({ message: "not_found" });
    const key = req.headers["x-sfqa-run-key"];
    const result = await opts.bridge.dispatch(req.params.id, typeof key === "string" ? key : undefined, req.params.kind, req.body);
    return reply.code(result.status).send({ message: result.message });
  });

  app.get("/orgs", async () => loadOrgsConfig(opts.orgsConfigPath));

  // Registers the org behind a Salesforce hostname (e.g. rms--dev.sandbox.lightning.force.com).
  // URLs are derived server-side from the hostname; the page never supplies them.
  app.post("/orgs/detect", async (req, reply) => {
    const parsed = DetectRequest.safeParse(req.body);
    const detected = parsed.success ? detectOrgFromHostname(parsed.data.hostname) : undefined;
    if (!detected) return reply.code(400).send({ error: "not_salesforce_host" });

    const matches = (o: Org) => myDomainOf(o.instanceUrl) === detected.myDomain || myDomainOf(o.loginUrl) === detected.myDomain;
    const known = (await loadOrgsConfig(opts.orgsConfigPath)).orgs.find(matches);
    if (known) return { org: known, created: false };

    return updateOrgsConfig(opts.orgsConfigPath, (config) => {
      const existing = config.orgs.find(matches);
      if (existing) return { org: existing, created: false };
      let id = detected.id;
      for (let n = 2; config.orgs.some((o) => o.id === id); n++) id = `${detected.id}-${n}`;
      const org: Org = { id, name: detected.name, loginUrl: detected.loginUrl, instanceUrl: detected.instanceUrl, personas: [] };
      config.orgs.push(org);
      return { org, created: true };
    });
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/personas", async (req, reply) => {
    const parsed = NewPersona.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const base = toSlug(parsed.data.name);
    if (!base) return reply.code(400).send({ error: "invalid_persona_name" });

    const persona = await updateOrgsConfig(opts.orgsConfigPath, (config) => {
      const org = config.orgs.find((o) => o.id === req.params.orgId);
      if (!org) throw new HttpError(404, { error: "unknown_org", orgId: req.params.orgId });
      // Several users may share a persona name (two Sales users); only the same user under the
      // same name is a duplicate. The id stays unique: sales, sales-2, ...
      const same = org.personas.find((p) => toSlug(p.name) === base && p.username?.toLowerCase() === parsed.data.username.toLowerCase());
      if (same) throw new HttpError(409, { error: "persona_exists", personaId: same.id });
      let id = base;
      for (let n = 2; org.personas.some((p) => p.id === id); n++) id = `${base}-${n}`;
      const created: Persona = { id, ...parsed.data };
      org.personas.push(created);
      return created;
    });
    return reply.code(201).send(persona);
  });

  app.delete<{ Params: { orgId: string; personaId: string } }>("/orgs/:orgId/personas/:personaId", async (req, reply) => {
    await updateOrgsConfig(opts.orgsConfigPath, (config) => {
      const org = config.orgs.find((o) => o.id === req.params.orgId);
      const index = org?.personas.findIndex((p) => p.id === req.params.personaId) ?? -1;
      if (!org || index < 0) throw new HttpError(404, { error: "unknown_org_or_persona" });
      org.personas.splice(index, 1);
    });
    return reply.code(204).send();
  });

  const findOrg = async (orgId: string): Promise<Org> => {
    const org = (await loadOrgsConfig(opts.orgsConfigPath)).orgs.find((o) => o.id === orgId);
    if (!org) throw new HttpError(404, { error: "unknown_org", orgId });
    return org;
  };

  // Active users of the org, for linking a persona to a Salesforce user. Uses the saved admin session.
  app.get<{ Params: { orgId: string }; Querystring: { q?: string } }>("/orgs/:orgId/users", async (req, reply) => {
    if (!opts.searchUsers) return reply.code(501).send({ error: "user_search_not_available" });
    const term = (req.query.q ?? "").slice(0, 80);
    return { users: await opts.searchUsers(await findOrg(req.params.orgId), term) };
  });

  const connectsInProgress = new Set<string>();

  // ?verify=1 also asks Salesforce whether each saved admin session still works (used when the panel opens).
  app.get<{ Querystring: { verify?: string } }>("/connections", async (req) => {
    const config = await loadOrgsConfig(opts.orgsConfigPath);
    const verify = req.query.verify === "1" && opts.verifyConnection;
    const connections = await Promise.all((await listConnections(opts.authDir, config)).map(async (c) => {
      const org = config.orgs.find((o) => o.id === c.orgId)!;
      const expired = verify && c.connected && !connectsInProgress.has(c.orgId) ? !(await verify(org)) : undefined;
      return { ...c, connectInProgress: connectsInProgress.has(c.orgId), ...(expired !== undefined && { expired }) };
    }));
    return { connections };
  });

  // One-time admin login for an org, in a visible Playwright window on this machine.
  // Returns immediately; poll GET /connections for the result.
  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/connect", async (req, reply) => {
    if (!SlugId.safeParse(req.params.orgId).success) return reply.code(400).send({ error: "invalid_id" });
    if (!opts.connectOrg) return reply.code(501).send({ error: "connect_not_available" });
    const org = await findOrg(req.params.orgId);

    if (connectsInProgress.has(org.id)) return reply.code(409).send({ error: "connect_in_progress" });
    connectsInProgress.add(org.id);
    opts.connectOrg(org)
      .then(() => app.log.info(`Connected ${org.id}`))
      .catch((err: Error) => app.log.warn(`Connect for ${org.id} did not complete: ${err.message}`))
      .finally(() => connectsInProgress.delete(org.id));
    return reply.code(202).send({ started: true });
  });

  app.post("/runs", async (req, reply) => {
    const parsed = RunRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const { orgId, personaId, extraPersonaIds = [] } = parsed.data;
    const { orgs } = await loadOrgsConfig(opts.orgsConfigPath);
    const org = orgs.find((o) => o.id === orgId);
    if (!org) return reply.code(404).send({ error: "unknown_org", orgId });
    for (const id of [personaId, ...extraPersonaIds]) {
      if (!org.personas.some((p) => p.id === id)) return reply.code(404).send({ error: "unknown_persona", orgId, personaId: id });
    }
    if (new Set([personaId, ...extraPersonaIds]).size !== extraPersonaIds.length + 1) {
      return reply.code(400).send({ error: "duplicate_persona", message: "Each persona may appear only once in a test." });
    }
    const run = store.create(parsed.data);
    opts.onRunCreated?.(run);
    return reply.code(202).send(run);
  });

  // --- Batches uploaded from Excel/CSV ------------------------------------------
  // Each selected row becomes one normal run (POST /runs equivalent), queued in order; the runner
  // executes runs strictly one at a time, so a batch runs sequentially through the same flow.

  // Reads the file and returns the detected rows for review. Nothing is run.
  app.post("/suites/parse", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const parsed = ParseSuiteRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const org = await findOrg(parsed.data.orgId);
    try {
      const { rows, sheet } = await readRows(parsed.data.fileName, Buffer.from(parsed.data.data, "base64"));
      return toSuite(parsed.data.fileName, rows, org.personas, sheet);
    } catch (err) {
      if (err instanceof SuiteFileError) return reply.code(422).send({ error: "invalid_file", message: err.message });
      throw err;
    }
  });

  app.post("/suites", async (req, reply) => {
    const parsed = StartSuiteRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const { orgId, fileName, defaultPersonaId, cases, project, fast } = parsed.data;
    const org = await findOrg(orgId);
    const personaOf = (id?: string) => org.personas.find((p) => p.id === (id ?? defaultPersonaId));

    // Validate every row before queuing any, so a bad batch never half-starts.
    const missing = cases.filter((c) => !personaOf(c.personaId)).map((c) => c.tcId);
    if (missing.length) {
      return reply.code(400).send({ error: "persona_required", message: `Choose a default persona for: ${missing.join(", ")}` });
    }
    const unknownExtra = cases.filter((c) => (c.extraPersonaIds ?? []).some((id) => !org.personas.some((p) => p.id === id))).map((c) => c.tcId);
    if (unknownExtra.length) {
      return reply.code(400).send({ error: "unknown_persona", message: `Unknown persona in: ${unknownExtra.join(", ")}` });
    }

    const suiteId = suites.create(orgId, fileName, []);
    const items = cases.map((c) => {
      const persona = personaOf(c.personaId)!;
      // The primary persona never repeats as an extra one (it may be the default persona).
      const extra = [...new Set(c.extraPersonaIds ?? [])].filter((id) => id !== persona.id);
      const run = store.create({
        orgId,
        personaId: persona.id,
        ...(extra.length && { extraPersonaIds: extra }),
        testCase: { title: `${c.tcId} - ${c.title}`.slice(0, 200), body: c.body },
        suiteId,
        ...(project && { project }),
        ...(fast !== undefined && { fast }),
      });
      opts.onRunCreated?.(run);
      const names = [persona, ...extra.map((id) => org.personas.find((p) => p.id === id)!)].map((p) => p.name).join(" + ");
      return { tcId: c.tcId, title: c.title, ...(c.module && { module: c.module }), personaId: persona.id, personaName: names, runId: run.id };
    });
    suites.setItems(suiteId, items);
    return reply.code(202).send(suites.get(suiteId));
  });

  app.get<{ Params: { id: string } }>("/suites/:id", async (req, reply) => {
    const suite = suites.get(req.params.id);
    if (!suite) return reply.code(404).send({ error: "suite_not_found" });
    return suite;
  });

  app.post<{ Params: { id: string } }>("/suites/:id/cancel", async (req, reply) => {
    if (!suites.get(req.params.id)) return reply.code(404).send({ error: "suite_not_found" });
    const cancelled = suites.cancel(req.params.id);
    return { cancelled, suite: suites.get(req.params.id) };
  });

  // --- Test case review against a requirements document ----------------------------
  // Claude reads the BRD / requirement sheet and the uploaded test cases and judges each case;
  // nothing runs in Salesforce. Returns immediately; poll GET /reviews/:id for progress.

  // base64 of a 10 MB document plus up to 200 test cases.
  app.post("/reviews", { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    if (!opts.reviews) return reply.code(501).send({ error: "reviews_not_available" });
    const parsed = StartReviewRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const org = await findOrg(parsed.data.orgId);
    if (opts.reviews.busy()) return reply.code(409).send({ error: "review_in_progress", message: "A review is already running. Wait for it to finish." });
    let requirements;
    try {
      requirements = await extractRequirements(parsed.data.requirements.fileName, Buffer.from(parsed.data.requirements.data, "base64"));
    } catch (err) {
      if (err instanceof RequirementsFileError) return reply.code(422).send({ error: "invalid_requirements_file", message: err.message });
      throw err;
    }
    return reply.code(202).send(await opts.reviews.start(org, parsed.data, requirements));
  });

  app.get<{ Params: { id: string } }>("/reviews/:id", async (req, reply) => {
    const review = opts.reviews?.get(req.params.id);
    if (!review) return reply.code(404).send({ error: "review_not_found" });
    return review;
  });

  app.get("/runs", async () => ({ runs: store.list() }));

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const run = store.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    return run;
  });

  app.get<{ Params: { id: string; file: string } }>("/runs/:id/evidence/:file", async (req, reply) => {
    const { id, file } = req.params;
    if (!RunId.safeParse(id).success || !isEvidenceFile(file)) {
      return reply.code(400).send({ error: "invalid_evidence_path" });
    }
    // Screenshots live in the run's folder (qa/Screenshots/<RUN-ID>/, or the project's
    // Test Execution Reports/<RUN-ID>/); run.json stays in runs/<id>/.
    const run = store.get(id);
    const displayId = run?.displayId;
    let reportsWs = opts.qa;
    if (run?.reports && opts.projects) reportsWs = await opts.projects.workspace(run.reports.project, run.request.orgId).catch(() => undefined);
    const dir = file !== "run.json" && displayId && reportsWs ? reportsWs.screenshotsDir(displayId) : join(opts.runsDir, id);
    try {
      const data = await readFile(join(dir, file));
      const type = file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "image/jpeg";
      return reply.type(type).send(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "evidence_not_found" });
      throw err;
    }
  });

  // Sends the current state first, then streams live events until the run completes.
  app.get<{ Params: { id: string } }>("/runs/:id/events", { websocket: true }, (socket, req) => {
    const run = store.get(req.params.id);
    if (!run) {
      socket.close(4404, "run_not_found");
      return;
    }
    const send = (event: RunEvent) => socket.send(JSON.stringify(event));

    if (run.status === "completed" || run.status === "error") {
      send({ type: "run.completed", runId: run.id, run });
      socket.close(1000);
      return;
    }

    send({ type: "run.status", runId: run.id, status: run.status, at: new Date().toISOString() });
    const unsubscribe = store.subscribe(run.id, (event) => {
      send(event);
      if (event.type === "run.completed") socket.close(1000);
    });
    const heartbeat = setInterval(() => send({ type: "run.heartbeat", runId: run.id, at: new Date().toISOString() }), HEARTBEAT_MS);
    socket.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
