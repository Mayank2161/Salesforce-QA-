import type {
  CaseUpdate, GeneratedCase, Generation, RunTestSetRequest, SaveTestSetRequest, StartGenerationRequest, TestSet,
  NewPersona, Org, OrgConnection, OrgsConfig, ParsedSuite, Persona, Review, Run, RunEvent, RunRequest, SalesforceUser, StartReviewRequest,
  StartSuiteRequest, Suite,
} from "@sfqa/shared";

// Project folders on the agent's computer (QA-Workspace/Projects/<project>/<org>/).
export interface ProjectOrg { orgId: string; folder: string; orgName: string }
export interface Project { name: string; orgs: ProjectOrg[] }
export interface Note { id: string; title: string; body: string; updatedOn: string }
export type ProjectSection = "Test Execution Reports" | "Bug Reports" | "Notes";
export interface ReportLinks {
  executionReport: string; bugReport: string; reviewReport: string;
  scope?: { project: string; folder: string } | { org: string };
}

// An earlier Jira story generation, for the "Recent stories" list.
export interface GenerationSummary { id: string; storyKey: string; createdAt: string; status: Generation["status"]; cases: number; project?: string }

// An org's admin connection, plus who connected it.
export type Connection = OrgConnection & { name?: string; username?: string };

// Content script -> background requests. All server traffic goes through the background worker,
// which holds the token and is not subject to the Salesforce page's CORS/CSP.
export type BgRequest =
  | { type: "status" }
  | { type: "detectOrg"; hostname: string }
  | { type: "getOrgs" }
  | { type: "getConnections"; verify?: boolean }
  | { type: "connectOrg"; orgId: string }
  | { type: "searchUsers"; orgId: string; q: string }
  | { type: "addPersona"; orgId: string; persona: NewPersona }
  | { type: "removePersona"; orgId: string; personaId: string }
  | { type: "createRun"; request: RunRequest }
  | { type: "getReportLinks"; project?: string; orgId?: string }
  | { type: "startGeneration"; request: StartGenerationRequest }
  | { type: "getGeneration"; id: string }
  | { type: "listGenerations"; orgId: string }
  | { type: "deleteGeneration"; id: string }
  | { type: "listTestSets"; orgId: string; project?: string }
  | { type: "saveTestSet"; request: SaveTestSetRequest }
  | { type: "getTestSet"; id: string }
  | { type: "deleteTestSet"; id: string }
  | { type: "runTestSet"; id: string; options: Partial<RunTestSetRequest> }
  | { type: "updateCase"; id: string; tcId: string; update: CaseUpdate }
  | { type: "exportCases"; id: string; approved?: boolean }
  | { type: "getProjects" }
  | { type: "createProject"; name: string }
  | { type: "addProjectOrg"; project: string; orgId: string }
  | { type: "openProjectFolder"; project: string; orgId?: string; section?: ProjectSection }
  | { type: "listNotes"; project: string; orgId: string }
  | { type: "createNote"; project: string; orgId: string; title: string; body: string }
  | { type: "updateNote"; project: string; orgId: string; id: string; title: string; body: string }
  | { type: "deleteNote"; project: string; orgId: string; id: string }
  | { type: "getRuns" }
  | { type: "getRun"; runId: string }
  | { type: "parseSuite"; orgId: string; fileName: string; data: string }
  | { type: "startSuite"; request: StartSuiteRequest }
  | { type: "getSuite"; id: string }
  | { type: "cancelSuite"; id: string }
  | { type: "startReview"; request: StartReviewRequest }
  | { type: "getReview"; id: string }
  | { type: "getEvidence"; runId: string; file: string }
  | { type: "openOptions" };

export interface BgResponses {
  status: { serverUrl: string };
  detectOrg: { org: Org; created: boolean };
  getOrgs: OrgsConfig;
  getConnections: { connections: Connection[] };
  connectOrg: { started: boolean };
  searchUsers: { users: SalesforceUser[] };
  addPersona: Persona;
  removePersona: null;
  createRun: Run;
  getReportLinks: ReportLinks;
  startGeneration: Generation;
  getGeneration: Generation;
  listGenerations: { generations: GenerationSummary[] };
  deleteGeneration: null;
  listTestSets: { testSets: TestSet[] };
  saveTestSet: TestSet;
  getTestSet: TestSet;
  deleteTestSet: null;
  runTestSet: { set: TestSet; suite: Suite };
  updateCase: GeneratedCase;
  exportCases: { dataUrl: string; fileName: string };
  getProjects: { root: string; projects: Project[] };
  createProject: Project;
  addProjectOrg: ProjectOrg;
  openProjectFolder: { path: string };
  listNotes: { notes: Note[] };
  createNote: Note;
  updateNote: Note;
  deleteNote: null;
  getRuns: { runs: Run[] };
  getRun: Run;
  parseSuite: ParsedSuite;
  startSuite: Suite;
  getSuite: Suite;
  cancelSuite: { cancelled: number; suite: Suite };
  startReview: Review;
  getReview: Review;
  getEvidence: { dataUrl: string };
  openOptions: null;
}

export type BgResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Long-lived port for streaming run events: content sends { runId }, background forwards RunEvents.
export const RUN_EVENTS_PORT = "run-events";
export type PortMessage = { kind: "event"; event: RunEvent } | { kind: "error"; error: string };

export interface Settings {
  serverUrl: string;
  token: string;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: "http://127.0.0.1:4317", token: "" };

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(["serverUrl", "token"]);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export const RELOADED_MESSAGE = "The extension was reloaded. Refresh this page.";

let reloadedListener: (() => void) | undefined;

/** Called once when the page's panel finds the extension was reloaded or updated under it. */
export function onExtensionReloaded(listener: () => void): void {
  reloadedListener = listener;
}

function extensionGone(): void {
  const listener = reloadedListener;
  reloadedListener = undefined;
  listener?.();
}

// After the extension is reloaded, the panel already on a page is cut off from it, and every
// chrome.* call throws "Extension context invalidated" (even synchronously). The panel uses
// these wrappers so that never surfaces as an uncaught error; it asks for a page refresh instead.
export const panelStorage = {
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    try {
      return await chrome.storage.local.get(keys);
    } catch {
      extensionGone();
      return {};
    }
  },
  set(items: Record<string, unknown>): void {
    try {
      chrome.storage.local.set(items).catch(extensionGone);
    } catch {
      extensionGone();
    }
  },
  remove(keys: string | string[]): void {
    try {
      chrome.storage.local.remove(keys).catch(extensionGone);
    } catch {
      extensionGone();
    }
  },
};

/** Opens a long-lived connection to the background worker, or undefined if the extension was reloaded. */
export function connectPort(name: string): chrome.runtime.Port | undefined {
  try {
    return chrome.runtime.connect({ name });
  } catch {
    extensionGone();
    return undefined;
  }
}

export async function send<K extends BgRequest["type"]>(
  request: Extract<BgRequest, { type: K }>,
): Promise<BgResponses[K]> {
  let result: BgResult<BgResponses[K]> | undefined;
  try {
    result = await chrome.runtime.sendMessage(request);
  } catch {
    extensionGone();
    throw new Error(RELOADED_MESSAGE);
  }
  if (!result) throw new Error("No response from the extension background worker.");
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
