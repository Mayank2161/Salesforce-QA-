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
  // Sent every few seconds while a run is quiet. Chrome suspends an extension's background worker
  // (and drops its connection) after about 30 seconds without traffic.
  z.object({ type: z.literal("run.heartbeat"), runId: RunId, at: IsoDateTime }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
