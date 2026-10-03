import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { SlugId } from "@sfqa/shared";
import type { Org, OrgConnection, OrgsConfig } from "@sfqa/shared";

// The org admin's saved session lives at auth/<orgId>/admin.json. Every persona runs from it via Login As.
// Ids are re-validated so a bad id can never escape AUTH_DIR.
export function adminSessionPath(authDir: string, orgId: string): string {
  return join(authDir, SlugId.parse(orgId), "admin.json");
}

export function adminMetaPath(authDir: string, orgId: string): string {
  return join(authDir, SlugId.parse(orgId), "admin.meta.json");
}

export interface AdminMeta {
  name?: string;
  username?: string;
}

export async function readAdminMeta(authDir: string, orgId: string): Promise<AdminMeta> {
  try {
    return JSON.parse(await readFile(adminMetaPath(authDir, orgId), "utf8")) as AdminMeta;
  } catch {
    return {};
  }
}

export async function orgConnection(authDir: string, orgId: string): Promise<OrgConnection & AdminMeta> {
  try {
    const s = await stat(adminSessionPath(authDir, orgId));
    return { orgId, connected: true, savedAt: s.mtime.toISOString(), ...(await readAdminMeta(authDir, orgId)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { orgId, connected: false };
    throw err;
  }
}

export function listConnections(authDir: string, config: OrgsConfig): Promise<(OrgConnection & AdminMeta)[]> {
  return Promise.all(config.orgs.map((org) => orgConnection(authDir, org.id)));
}

// My Domain base URL (https://acme--uat.sandbox.my.salesforce.com). Login As and the REST API live here,
// whatever loginUrl says (it may be test.salesforce.com for hand-written configs).
export function myDomainUrl(org: Org): string {
  const host = new URL(org.instanceUrl).hostname.replace(/\.lightning\.force\.com$/, ".my.salesforce.com");
  return `https://${host}`;
}

export function isLightningUrl(url: URL): boolean {
  return url.pathname.startsWith("/lightning/");
}

// Lightning's global header; its presence means the app shell rendered for a logged-in user.
const LIGHTNING_HEADER = "#oneHeader, .slds-global-header";

export async function waitForLightning(page: Page, timeout = 45_000): Promise<boolean> {
  try {
    await page.locator(LIGHTNING_HEADER).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}
