import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Org } from "@sfqa/shared";
import { adminApi } from "./api.ts";
import { launchBrowser, type BrowserSettings } from "./browser.ts";
import { adminMetaPath, adminSessionPath, isLightningUrl, myDomainUrl, waitForLightning } from "./session.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

export class LoginCancelled extends Error {
  override name = "LoginCancelled";
}

// One-time per org: opens a visible Playwright browser (never your own Chrome) at the org's My Domain
// login page. The admin logs in once (MFA included); the session is saved to auth/<org>/admin.json.
// Every persona then runs through Login As from this session. Passwords are never stored.
export async function connectOrg(opts: {
  org: Org;
  authDir: string;
  browser: BrowserSettings;
  onReady?: () => void;
}): Promise<{ file: string; name?: string; username?: string }> {
  const { org } = opts;
  const file = adminSessionPath(opts.authDir, org.id);
  const browser = await launchBrowser(opts.browser, { headless: false });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(myDomainUrl(org), { timeout: 90_000 });
    opts.onReady?.();

    await page.waitForURL((u) => isLightningUrl(u), { timeout: LOGIN_TIMEOUT_MS });
    await waitForLightning(page, 60_000);

    await mkdir(dirname(file), { recursive: true });
    await context.storageState({ path: file });

    // Record who connected, for display. Not fatal if the API is unavailable.
    const me = await adminApi(opts.authDir, org).then((api) => api.whoAmI()).catch(() => undefined);
    const meta = { name: me?.name, username: me?.username };
    await writeFile(adminMetaPath(opts.authDir, org.id), JSON.stringify(meta, null, 2));
    return { file, ...meta };
  } catch (err) {
    const message = (err as Error).message;
    if (/closed|Target page/i.test(message)) throw new LoginCancelled("Connect cancelled: the browser window was closed.");
    throw err;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
