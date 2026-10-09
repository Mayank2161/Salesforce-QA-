import type { RunEvent } from "@sfqa/shared";
import { RUN_EVENTS_PORT, loadSettings, type BgRequest, type BgResult, type PortMessage } from "./messages.ts";

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const { serverUrl, token } = await loadSettings();
  if (!token) throw new Error("No agent token set. Open the extension settings and paste AGENT_TOKEN from .env.");

  let res: Response;
  try {
    res = await fetch(new URL(path, serverUrl), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(`Agent server not reachable at ${serverUrl}. Start it with: npm run dev`);
  }
  if (res.status === 401) throw new Error("Agent token rejected. Check the token in the extension settings.");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Server error ${res.status}`);
  }
  return res;
}

const json = async (path: string, init?: RequestInit): Promise<unknown> => (await api(path, init)).json();

const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function handle(req: BgRequest): Promise<unknown> {
  switch (req.type) {
    case "status": {
      await json("/connections"); // exercises reachability and the token in one call
      return { serverUrl: (await loadSettings()).serverUrl };
    }
    case "detectOrg":
      return json("/orgs/detect", jsonBody({ hostname: req.hostname }));
    case "getOrgs":
      return json("/orgs");
    case "getConnections":
      return json(req.verify ? "/connections?verify=1" : "/connections");
    case "connectOrg":
      return json(`/orgs/${encodeURIComponent(req.orgId)}/connect`, jsonBody({}));
    case "searchUsers":
      return json(`/orgs/${encodeURIComponent(req.orgId)}/users?q=${encodeURIComponent(req.q)}`);
    case "addPersona":
      return json(`/orgs/${encodeURIComponent(req.orgId)}/personas`, jsonBody(req.persona));
    case "removePersona":
      await api(`/orgs/${encodeURIComponent(req.orgId)}/personas/${encodeURIComponent(req.personaId)}`, { method: "DELETE" });
      return null;
    case "createRun":
      return json("/runs", jsonBody(req.request));
    case "getReportLinks":
      return json("/reports/links");
    case "getRuns":
      return json("/runs");
    case "parseSuite":
      return json("/suites/parse", jsonBody({ orgId: req.orgId, fileName: req.fileName, data: req.data }));
    case "startSuite":
      return json("/suites", jsonBody(req.request));
    case "getSuite":
      return json(`/suites/${encodeURIComponent(req.id)}`);
    case "cancelSuite":
      return json(`/suites/${encodeURIComponent(req.id)}/cancel`, jsonBody({}));
    case "startReview":
      return json("/reviews", jsonBody(req.request));
    case "getReview":
      return json(`/reviews/${encodeURIComponent(req.id)}`);
    case "getEvidence": {
      const res = await api(`/runs/${encodeURIComponent(req.runId)}/evidence/${encodeURIComponent(req.file)}`);
      const type = res.headers.get("content-type") ?? "image/png";
      return { dataUrl: `data:${type};base64,${toBase64(await res.arrayBuffer())}` };
    }
    case "openOptions":
      await chrome.runtime.openOptionsPage();
      return null;
  }
}

chrome.runtime.onMessage.addListener((req: BgRequest, _sender, sendResponse: (r: BgResult<unknown>) => void) => {
  handle(req).then(
    (data) => sendResponse({ ok: true, data }),
    (err: Error) => sendResponse({ ok: false, error: err.message }),
  );
  return true; // keep the channel open for the async response
});

// Bridges the server's run WebSocket to the content script. An open WebSocket keeps the worker alive.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== RUN_EVENTS_PORT) return;
  let ws: WebSocket | undefined;
  const post = (msg: PortMessage) => { try { port.postMessage(msg); } catch { /* port already closed */ } };

  port.onMessage.addListener(async ({ runId }: { runId: string }) => {
    const { serverUrl, token } = await loadSettings();
    const url = new URL(`/runs/${encodeURIComponent(runId)}/events`, serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);

    ws = new WebSocket(url);
    ws.onmessage = (e) => post({ kind: "event", event: JSON.parse(e.data as string) as RunEvent });
    ws.onerror = () => post({ kind: "error", error: "Lost connection to the agent server." });
    ws.onclose = () => port.disconnect();
  });
  port.onDisconnect.addListener(() => ws?.close());
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
