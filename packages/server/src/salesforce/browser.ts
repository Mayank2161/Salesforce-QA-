import { chromium, type Browser } from "playwright";

export interface BrowserSettings {
  // "chrome" uses the installed Google Chrome; "chromium" uses Playwright's bundled build.
  channel: string;
  headless: boolean;
}

export function browserSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserSettings {
  return {
    channel: env.BROWSER_CHANNEL || "chrome",
    headless: env.HEADLESS !== "false",
  };
}

export function launchBrowser(settings: BrowserSettings, overrides: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({
    channel: settings.channel === "chromium" ? undefined : settings.channel,
    headless: overrides.headless ?? settings.headless,
  });
}
