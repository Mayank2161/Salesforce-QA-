import { z } from "zod";
import { SlugId } from "./ids.ts";

// A test case as pasted by the user. It is free text; the AI turns it into steps in Phase 2.
export const TestCase = z.object({
  title: z.string().max(200).optional(),
  body: z.string().trim().min(1).max(20_000),
});
export type TestCase = z.infer<typeof TestCase>;

// Body of POST /runs.
export const RunRequest = z.object({
  orgId: SlugId,
  personaId: SlugId,
  // Other personas the test case needs (for example a manager who approves what the first persona
  // submitted). Each gets its own browser, logged in as that persona, for the whole run.
  extraPersonaIds: z.array(SlugId).max(3).optional(),
  testCase: TestCase,
  // Set when the run is one row of an uploaded batch (see suite.ts).
  suiteId: z.string().max(40).optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;
