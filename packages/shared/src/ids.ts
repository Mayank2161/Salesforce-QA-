import { z } from "zod";

// Org and persona ids become folder names (e.g. auth/<orgId>/<personaId>.json),
// so they are restricted to lowercase slugs to rule out path traversal.
export const SlugId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug (a-z, 0-9, hyphen)");

// "Sales Rep (EMEA)" -> "sales-rep-emea"
export function toSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export const RunId = z.uuid();
export type RunId = z.infer<typeof RunId>;

export const IsoDateTime = z.iso.datetime();
