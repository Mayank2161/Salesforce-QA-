// Derives org identity from a Salesforce hostname, so orgs are recognised automatically.
//   rms--dev.sandbox.lightning.force.com   -> RMS - DEV (sandbox)
//   rms.my.salesforce.com                  -> RMS - PRODUCTION
//   acme-dev-ed.develop.lightning.force.com -> ACME - DEV ED (developer)

export type OrgKind = "production" | "sandbox" | "developer" | "scratch" | "trailhead" | "demo";

export interface DetectedOrg {
  id: string;
  name: string;
  kind: OrgKind;
  // First hostname label, shared by every domain of the org (e.g. "rms--dev").
  myDomain: string;
  loginUrl: string;
  instanceUrl: string;
}

const HOST = /^([a-z0-9-]+)(?:\.(sandbox|develop|scratch|trailblaze|demo))?\.(?:my\.salesforce\.com|my\.salesforce-setup\.com|lightning\.force\.com)$/;

const QUALIFIER_KIND: Record<string, OrgKind> = {
  sandbox: "sandbox",
  develop: "developer",
  scratch: "scratch",
  trailblaze: "trailhead",
  demo: "demo",
};

export function detectOrgFromHostname(hostname: string): DetectedOrg | undefined {
  const match = HOST.exec(hostname.toLowerCase());
  if (!match) return undefined;
  const myDomain = match[1]!;
  const qualifier = match[2];

  // "rms--dev": company "rms", sandbox "dev". Older non-enhanced sandbox domains omit ".sandbox".
  const [company = myDomain, sandboxName] = myDomain.split("--");
  const kind: OrgKind = qualifier ? QUALIFIER_KIND[qualifier]! : sandboxName ? "sandbox" : "production";

  let base = company;
  let label: string;
  if (sandboxName) {
    label = sandboxName;
  } else if (kind === "developer" && base.endsWith("-dev-ed")) {
    base = base.slice(0, -"-dev-ed".length);
    label = "dev ed";
  } else {
    label = kind;
  }

  const id = `${base}-${label}`.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const domainRoot = qualifier ? `${myDomain}.${qualifier}` : myDomain;
  return {
    id,
    name: `${base.toUpperCase()} - ${label.toUpperCase()}`,
    kind,
    myDomain,
    loginUrl: `https://${domainRoot}.my.salesforce.com`,
    instanceUrl: `https://${domainRoot}.lightning.force.com`,
  };
}

// Key used to match any of an org's domains to each other.
export function myDomainOf(url: string): string {
  return new URL(url).hostname.split(".")[0]!.toLowerCase();
}
