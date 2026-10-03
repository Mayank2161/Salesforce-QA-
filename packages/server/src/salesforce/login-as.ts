import { access } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Org, Persona } from "@sfqa/shared";
import { SalesforceApiError, adminApi, findUser } from "./api.ts";
import { adminSessionPath, isLightningUrl, myDomainUrl, waitForLightning } from "./session.ts";

export type PersonaAuthFailure =
  | "not_connected"
  | "admin_expired"
  | "persona_has_no_user"
  | "user_not_found"
  | "user_inactive"
  | "login_as_failed";

export type PersonaSession =
  | { ok: true; context: BrowserContext; page: Page; user: { id: string; name: string; username: string } }
  | { ok: false; code: PersonaAuthFailure; message: string; context?: BrowserContext; page?: Page };

const HOME = "/lightning/page/home";

// "Logged in as Jeff Kraft (jeffkraft@rms.com) | Sandbox: tmcdev | Log out as Jeff Kraft"
// Compares the username in parentheses exactly; the name is only a fallback if no username is shown.
export function bannerShowsUser(bannerText: string, user: { name: string; username: string }): boolean {
  const match = /Logged in as\s+(.+?)\s*\(([^)\s]+)\)/i.exec(bannerText);
  if (match) return match[2]!.toLowerCase() === user.username.toLowerCase();
  return new RegExp(`Logged in as\\s+${user.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(bannerText);
}

// Authenticates an isolated Playwright context as the persona's Salesforce user, the same way as
// clicking "Login" on the user's record in Setup:
//   1. load the org admin's saved session into a fresh context (nothing shared with your own Chrome)
//   2. resolve the persona's Salesforce user (Id, or look it up by username)
//   3. open /servlet/servlet.su (Salesforce's Login As endpoint) for that user
//   4. confirm Lightning loads with the "Logged in as <user>" banner
export async function openAsPersona(opts: {
  // Called only once the admin session and user check out, so failed pre-checks never start a browser.
  browser: () => Promise<Browser>;
  org: Org;
  persona: Persona;
  authDir: string;
  log?: (message: string) => void;
}): Promise<PersonaSession> {
  const { org, persona, log = () => {} } = opts;
  const adminFile = adminSessionPath(opts.authDir, org.id);
  const reconnect = `Click "Connect org" in the QA Agent panel (or run: npm run connect -- --org ${org.id}).`;

  if (!(await access(adminFile).then(() => true, () => false))) {
    return { ok: false, code: "not_connected", message: `${org.name} is not connected yet. ${reconnect}` };
  }

  // Resolve the org and user through the admin session before opening a browser, so failures are fast.
  let orgId: string;
  let user: { id: string; name: string; username: string };
  try {
    const api = await adminApi(opts.authDir, org);
    orgId = (await api.whoAmI()).orgId;
    if (!persona.userId && !persona.username) {
      return { ok: false, code: "persona_has_no_user", message: `Persona "${persona.name}" is not linked to a Salesforce user. Remove it and add it again from the panel.` };
    }
    const found = await findUser(api, { userId: persona.userId, username: persona.username });
    if (!found) {
      return { ok: false, code: "user_not_found", message: `Salesforce user ${persona.username ?? persona.userId} for "${persona.name}" was not found in ${org.name}.` };
    }
    if (!found.active) {
      return { ok: false, code: "user_inactive", message: `Salesforce user ${found.name} (${found.username}) is inactive in ${org.name}.` };
    }
    user = found;
  } catch (err) {
    if (err instanceof SalesforceApiError && (err.code === "session_expired" || err.code === "not_connected")) {
      return { ok: false, code: "admin_expired", message: `The saved admin session for ${org.name} has expired. ${reconnect}` };
    }
    throw err;
  }

  log(`Logging in as ${user.name} (${user.username}) via Login As`);
  const browser = await opts.browser();
  const context = await browser.newContext({ storageState: adminFile, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const su = new URL("/servlet/servlet.su", myDomainUrl(org));
  su.search = new URLSearchParams({ oid: orgId, suorgadminid: user.id, retURL: HOME, targetURL: HOME }).toString();
  await page.goto(su.toString(), { waitUntil: "domcontentloaded" });

  const loaded = await page.waitForURL((u) => isLightningUrl(u), { timeout: 60_000 })
    .then(() => waitForLightning(page))
    .catch(() => false);

  // Salesforce shows "Logged in as <Name> (<username>)" while impersonating.
  const banner = page.getByText(/Logged in as/i).first();
  const bannerText = loaded ? await banner.waitFor({ timeout: 20_000 }).then(() => banner.innerText(), () => "") : "";
  const matches = bannerShowsUser(bannerText, user);

  if (!loaded || !matches) {
    const where = new URL(page.url());
    const detail = !loaded ? `landed on ${where.hostname}${where.pathname}` : `banner said "${bannerText || "(none)"}"`;
    return {
      ok: false,
      code: "login_as_failed",
      message: `Login As ${user.name} failed (${detail}). Check the connected admin has the "Login As" permission and that administrators can log in as any user (Setup > Login Access Policies).`,
      context,
      page,
    };
  }
  return { ok: true, context, page, user };
}
