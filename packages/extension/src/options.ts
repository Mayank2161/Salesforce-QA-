import { DEFAULT_SETTINGS, loadSettings, send } from "./messages.ts";

const serverUrl = document.getElementById("serverUrl") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status") as HTMLDivElement;
const save = document.getElementById("save") as HTMLButtonElement;

function show(kind: "ok" | "err" | "", message: string): void {
  status.className = kind;
  status.textContent = message;
}

void loadSettings().then((s) => {
  serverUrl.value = s.serverUrl;
  token.value = s.token;
});

save.onclick = async () => {
  const url = serverUrl.value.trim() || DEFAULT_SETTINGS.serverUrl;
  try {
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error();
  } catch {
    show("err", "Server URL must be http://127.0.0.1:<port> or http://localhost:<port>.");
    return;
  }

  await chrome.storage.local.set({ serverUrl: url, token: token.value.trim() });
  show("", "Saved. Testing connection…");
  try {
    const { orgs } = await send({ type: "getOrgs" });
    show("ok", `Connected. ${orgs.length} org(s) configured: ${orgs.map((o) => o.name).join(", ") || "none"}.\nOpen any Salesforce page and click the blue QA button.`);
  } catch (err) {
    show("err", (err as Error).message);
  }
};
