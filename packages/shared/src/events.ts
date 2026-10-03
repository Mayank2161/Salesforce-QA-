import { z } from "zod";
import { IsoDateTime, RunId } from "./ids.ts";
import { BugRef, Run, RunStatus, StepResult } from "./run.ts";

// Messages the server pushes to the extension over the WebSocket.
export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.status"), runId: RunId, status: RunStatus, at: IsoDateTime }),
  z.object({ type: z.literal("run.step"), runId: RunId, step: StepResult }),
  z.object({ type: z.literal("run.bug"), runId: RunId, bug: BugRef }),
  z.object({
    type: z.literal("run.log"),
    runId: RunId,
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    at: IsoDateTime,
  }),
  z.object({ type: z.literal("run.completed"), runId: RunId, run: Run }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
