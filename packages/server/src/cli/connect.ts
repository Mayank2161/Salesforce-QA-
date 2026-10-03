// Usage: npm run connect -- --org <orgId>
// Same as the panel's "Connect org" button: one-time admin login for the org in a Playwright browser.
import { parseArgs } from "node:util";
import { loadOrgsConfig } from "../config/orgs.ts";
import { AUTH_DIR, ORGS_CONFIG_PATH } from "../paths.ts";
import { browserSettingsFromEnv } from "../salesforce/browser.ts";
import { connectOrg } from "../salesforce/login.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { org: { type: "string" } } });
const config = await loadOrgsConfig(ORGS_CONFIG_PATH).catch((err: Error) => fail(err.message));
const available = config.orgs.map((o) => `  --org ${o.id}   (${o.name})`).join("\n") || "  (none yet: open the QA Agent panel on the org first)";

if (!values.org) fail(`Usage: npm run connect -- --org <orgId>\n\nAvailable:\n${available}`);
const org = config.orgs.find((o) => o.id === values.org) ?? fail(`Unknown org "${values.org}". Available:\n${available}`);

try {
  const result = await connectOrg({
    org,
    authDir: AUTH_DIR,
    browser: browserSettingsFromEnv(),
    onReady: () => {
      console.log(`\nLog in to "${org.name}" as an administrator who can use "Login As".`);
      console.log("The session is saved automatically once Lightning loads. Close the window to cancel.\n");
    },
  });
  console.log(`Connected${result.name ? ` as ${result.name} (${result.username})` : ""}: ${result.file}`);
  console.log("Keep this file private: it works like a logged-in admin password until Salesforce expires it.");
} catch (err) {
  fail((err as Error).message);
}
