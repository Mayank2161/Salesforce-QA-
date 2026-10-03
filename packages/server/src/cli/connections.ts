// Usage: npm run connections [-- --verify]
// Lists which orgs have a saved admin session. --verify checks Salesforce still accepts each one.
import { parseArgs } from "node:util";
import { loadOrgsConfig } from "../config/orgs.ts";
import { AUTH_DIR, ORGS_CONFIG_PATH } from "../paths.ts";
import { adminApi } from "../salesforce/api.ts";
import { listConnections } from "../salesforce/session.ts";

const { values } = parseArgs({ options: { verify: { type: "boolean", default: false } } });
const config = await loadOrgsConfig(ORGS_CONFIG_PATH);

for (const c of await listConnections(AUTH_DIR, config)) {
  const org = config.orgs.find((o) => o.id === c.orgId)!;
  let status = c.connected ? `connected ${new Date(c.savedAt!).toLocaleString()}${c.name ? ` as ${c.name}` : ""}` : "not connected";
  if (values.verify && c.connected) {
    const me = await adminApi(AUTH_DIR, org).then((api) => api.whoAmI()).catch(() => undefined);
    status += me ? "  VALID" : `  EXPIRED (run npm run connect -- --org ${org.id})`;
  }
  console.log(`${org.id.padEnd(32)} ${org.name.padEnd(32)} ${status}`);
  for (const p of org.personas) console.log(`    persona ${p.name.padEnd(24)} -> ${p.userFullName ?? ""} ${p.username ?? "(no user linked)"}`);
}
if (config.orgs.length === 0) console.log("No orgs yet. Open the QA Agent panel on a Salesforce org first.");
