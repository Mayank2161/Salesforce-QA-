import { z } from "zod";
import { SlugId } from "./ids.ts";

// Salesforce User record Id, 15 or 18 characters, always prefixed 005.
export const SalesforceUserId = z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, "must be a Salesforce User Id (005...)");

// A persona is a real Salesforce user. Runs use the org admin's session and "Login As" this user,
// the same as clicking Login on the user's record in Setup. No persona passwords are ever stored.
export const Persona = z.object({
  id: SlugId,
  name: z.string().min(1),
  // The Salesforce user to Login As. The Id is filled in from the username on first use.
  username: z.string().min(1).optional(),
  userId: SalesforceUserId.optional(),
  userFullName: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type Persona = z.infer<typeof Persona>;

// Body of POST /orgs/:orgId/personas. The id is derived from the name.
export const NewPersona = z.object({
  name: z.string().trim().min(1).max(80),
  username: z.string().trim().min(1).max(200),
  userId: SalesforceUserId.optional(),
  userFullName: z.string().trim().min(1).max(200).optional(),
  profile: z.string().trim().min(1).max(200).optional(),
});
export type NewPersona = z.infer<typeof NewPersona>;

// A user row from the org, used to pick which Salesforce user a persona is.
export const SalesforceUser = z.object({
  id: SalesforceUserId,
  name: z.string(),
  username: z.string(),
  profile: z.string().optional(),
  role: z.string().optional(),
});
export type SalesforceUser = z.infer<typeof SalesforceUser>;

export const Org = z
  .object({
    id: SlugId,
    name: z.string().min(1),
    loginUrl: z.url({ protocol: /^https$/ }),
    instanceUrl: z.url({ protocol: /^https$/ }),
    // May start empty for auto-detected orgs; personas are added from the panel.
    personas: z.array(Persona),
  })
  .refine((org) => new Set(org.personas.map((p) => p.id)).size === org.personas.length, {
    message: "persona ids must be unique within an org",
    path: ["personas"],
  });
export type Org = z.infer<typeof Org>;

// Shape of config/orgs.json.
export const OrgsConfig = z
  .object({ orgs: z.array(Org) })
  .refine((cfg) => new Set(cfg.orgs.map((o) => o.id)).size === cfg.orgs.length, {
    message: "org ids must be unique",
    path: ["orgs"],
  });
export type OrgsConfig = z.infer<typeof OrgsConfig>;
