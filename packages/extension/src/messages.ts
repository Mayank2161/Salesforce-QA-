import type {
  NewPersona, Org, OrgConnection, OrgsConfig, ParsedSuite, Persona, Run, RunEvent, RunRequest, SalesforceUser, StartSuiteRequest, Suite,
} from "@sfqa/shared";

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
  | { type: "getReportLinks" }
  | { type: "getRuns" }
  | { type: "parseSuite"; orgId: string; fileName: string; data: string }
  | { type: "startSuite"; request: StartSuiteRequest }
  | { type: "getSuite"; id: string }
  | { type: "cancelSuite"; id: string }
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
  getReportLinks: { executionReport: string; bugReport: string };
  getRuns: { runs: Run[] };
  parseSuite: ParsedSuite;
  startSuite: Suite;
  getSuite: Suite;
  cancelSuite: { cancelled: number; suite: Suite };
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

export async function send<K extends BgRequest["type"]>(
  request: Extract<BgRequest, { type: K }>,
): Promise<BgResponses[K]> {
  let result: BgResult<BgResponses[K]> | undefined;
  try {
    result = await chrome.runtime.sendMessage(request);
  } catch {
    throw new Error("The extension was reloaded. Refresh this page.");
  }
  if (!result) throw new Error("No response from the extension background worker.");
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
