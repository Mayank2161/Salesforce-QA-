import { z } from "zod";
import { IsoDateTime, SlugId } from "./ids.ts";

// Whether an org's admin session is saved. The admin connects once per org; every persona
// then runs through "Login As" from that session. Presence does not guarantee Salesforce
// still accepts it; runs report BLOCKED with a reconnect hint if it has expired.
export const OrgConnection = z.object({
  orgId: SlugId,
  connected: z.boolean(),
  savedAt: IsoDateTime.optional(),
  // True while an admin login window opened from the panel is waiting for the user.
  connectInProgress: z.boolean().optional(),
  // Set when checked with ?verify=1: Salesforce no longer accepts the saved session.
  expired: z.boolean().optional(),
});
export type OrgConnection = z.infer<typeof OrgConnection>;
