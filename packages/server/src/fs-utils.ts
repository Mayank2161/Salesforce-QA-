import { rename, writeFile } from "node:fs/promises";

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

// Writes via a temp file and rename, so readers never see a half-written file.
// On Windows the rename fails while another process (a reader, antivirus, indexer) has the
// target open, so busy errors are retried briefly.
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (!BUSY.has((err as NodeJS.ErrnoException).code ?? "") || attempt >= 10) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}
