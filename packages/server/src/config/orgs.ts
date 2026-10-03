import { readFile } from "node:fs/promises";
import { z } from "zod";
import { OrgsConfig } from "@sfqa/shared";
import { writeFileAtomic } from "../fs-utils.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

// Read on every call so edits to config/orgs.json apply without restarting the server.
// A missing file means no orgs yet: they are added as the user visits them.
export async function loadOrgsConfig(path: string): Promise<OrgsConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { orgs: [] };
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  const result = OrgsConfig.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`${path} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let writeQueue: Promise<unknown> = Promise.resolve();

// Read-modify-write with writes serialised, so concurrent panel actions can't lose each other's changes.
// The result is validated before it replaces the file.
export function updateOrgsConfig<T>(path: string, change: (config: OrgsConfig) => T): Promise<T> {
  const task = writeQueue.then(async () => {
    const config = await loadOrgsConfig(path);
    const result = change(config);
    const validated = OrgsConfig.parse(config);
    await writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`);
    return result;
  });
  writeQueue = task.catch(() => undefined);
  return task;
}
