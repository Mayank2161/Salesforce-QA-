import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../fs-utils.ts";

// The qa/ folder, laid out like the RMS QA project so its report pages work unchanged:
//   qa/reports/Test_Execution_Report.html + execution-data.js
//   qa/bugs/Bug_Report.html + bug-data.js + <BUG-ID>/ evidence
//   qa/reviews/Test_Case_Review.html + review-data.js (test cases checked against a BRD)
//   qa/Screenshots/<RUN-ID>/ step screenshots
//   qa/assets/ shared CSS/JS
// The data files are the source of truth (the report pages can also save status edits into them).

export interface ExecutionStep {
  n: string | number;
  action: string;
  status: string;
  result: string;
}

export interface ExecutionRecord {
  runId: string;
  testCaseId: string;
  title: string;
  status: string;
  steps: ExecutionStep[];
  screenshots: { file: string; caption: string }[];
  bugs: string[];
  [field: string]: unknown;
}

export interface BugRecord {
  id: string;
  title: string;
  severity: string;
  status: string;
  linkedRun: string;
  linkedTestCase: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  attachments: { file: string; caption: string }[];
  reproducedIn: { run: string; testCase: string; on: string; note: string }[];
  [field: string]: unknown;
}

const EXECUTIONS = {
  file: ["reports", "execution-data.js"],
  global: "TEST_EXECUTIONS",
  header:
    "// Test execution records. Append one object per run; the report page (Test_Execution_Report.html) reads this file.\n" +
    '// status: "PASS" | "FAIL" | "BLOCKED" | "PENDING" | "RETEST" | "N/A"   step status: "PASS" | "FAIL" | "BLOCKED" | "N/A"\n' +
    "// statusHistory: manual status changes made from the report page.\n" +
    "// Screenshot paths are relative to this reports/ folder.",
};

const BUGS = {
  file: ["bugs", "bug-data.js"],
  global: "BUG_REPORTS",
  header:
    "// Bug records. Append one object per bug; the bug report page (Bug_Report.html) reads this file.\n" +
    '// severity: "Critical" | "High" | "Medium" | "Low"\n' +
    "// statusHistory: manual status changes made from the report page.\n" +
    "// Attachment paths are relative to this bugs/ folder. Each bug keeps its evidence in bugs/<BUG-ID>/.",
};

const REVIEWS = {
  file: ["reviews", "review-data.js"],
  global: "TEST_CASE_REVIEWS",
  header:
    "// Test case reviews against a requirements document (BRD). One object per review; the page (Test_Case_Review.html) reads this file.\n" +
    '// verdict: "Correct" | "Needs update" | "Incorrect" | "Not traceable"',
};

type DataFile = typeof EXECUTIONS;

export interface ReviewRecord {
  reviewId: string;
  createdOn: string;
  environment: string;
  testCasesFile: string;
  requirementsFile: string;
  status: "Complete" | "Incomplete";
  cases: { tcId: string; verdict: string; requirementIds: string[] }[];
  requirements: { id: string; title: string }[];
  [field: string]: unknown;
}

// A record the agent created for testing, kept so later test cases can reuse it.
export interface TestDataRecord {
  sobject: string;
  id: string;
  name: string;
  purpose: string;
  fields: Record<string, unknown>;
  createdInRun: string;
  testCase: string;
  createdOn: string;
}

// Evidence file names: screenshots Claude saves (flat, no paths) and the request/response records
// the server writes for call_api (api_02_get_account.json).
export const EVIDENCE_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(?:png|jpe?g)|api_\d{2,3}_[a-z0-9_-]{1,80}\.json)$/;

export class QaWorkspace {
  readonly root: string;
  readonly #templates: string;
  #queue: Promise<unknown> = Promise.resolve();
  #reservedRunIds = new Set<string>();
  #reservedReviewIds = new Set<string>();

  constructor(root: string, templatesDir: string) {
    this.root = root;
    this.#templates = templatesDir;
  }

  // Creates the folders and report pages. Existing pages and data are never overwritten.
  async ensure(): Promise<void> {
    await mkdir(join(this.root, "Screenshots"), { recursive: true });
    await cp(this.#templates, this.root, { recursive: true, force: false, errorOnExist: false });
    for (const df of [EXECUTIONS, BUGS, REVIEWS]) {
      const path = join(this.root, ...df.file);
      await mkdir(join(this.root, df.file[0]!), { recursive: true });
      await readFile(path).catch(() => writeFile(path, `${df.header}\nwindow.${df.global} = [];\n`));
    }
  }

  screenshotsDir(displayId: string): string {
    return join(this.root, "Screenshots", displayId);
  }

  // RUN-YYYYMMDD-NNN, numbered per day across screenshot folders and recorded runs.
  nextRunId(date = new Date()): Promise<string> {
    return this.#serial(async () => {
      const prefix = `RUN-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`;
      const folders = await readdir(join(this.root, "Screenshots")).catch(() => [] as string[]);
      const recorded = (await this.#read<ExecutionRecord>(EXECUTIONS)).map((r) => r.runId);
      let max = 0;
      for (const id of [...folders, ...recorded, ...this.#reservedRunIds]) {
        if (id.startsWith(prefix)) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
      }
      const id = `${prefix}${String(max + 1).padStart(3, "0")}`;
      this.#reservedRunIds.add(id);
      await mkdir(this.screenshotsDir(id), { recursive: true });
      return id;
    });
  }

  // REV-YYYYMMDD-NNN, numbered per day.
  nextReviewId(date = new Date()): Promise<string> {
    return this.#serial(async () => {
      const prefix = `REV-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`;
      const recorded = (await this.#read<ReviewRecord>(REVIEWS)).map((r) => r.reviewId);
      let max = 0;
      for (const id of [...recorded, ...this.#reservedReviewIds]) {
        if (id.startsWith(prefix)) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
      }
      const id = `${prefix}${String(max + 1).padStart(3, "0")}`;
      this.#reservedReviewIds.add(id);
      return id;
    });
  }

  listReviews(): Promise<ReviewRecord[]> {
    return this.#read<ReviewRecord>(REVIEWS);
  }

  appendReview(record: ReviewRecord): Promise<void> {
    return this.#serial(async () => {
      const reviews = await this.#read<ReviewRecord>(REVIEWS);
      reviews.push(record);
      await this.#write(REVIEWS, reviews);
      this.#reservedReviewIds.delete(record.reviewId);
    });
  }

  listBugs(): Promise<BugRecord[]> {
    return this.#read<BugRecord>(BUGS);
  }

  // Files a new bug and copies its screenshots into bugs/<BUG-ID>/.
  addBug(bug: Omit<BugRecord, "id" | "attachments">, evidence: { displayId: string; screenshots: { file: string; caption: string }[] }): Promise<BugRecord> {
    return this.#serial(async () => {
      const bugs = await this.#read<BugRecord>(BUGS);
      const next = Math.max(0, ...bugs.map((b) => Number(b.id.slice(4)) || 0)) + 1;
      const id = `BUG-${String(next).padStart(3, "0")}`;
      const record = { id, ...bug, attachments: await this.#copyEvidence(id, evidence) } as BugRecord;
      bugs.push(record);
      await this.#write(BUGS, bugs);
      return record;
    });
  }

  // Records that a run reproduced an existing bug, adding its new screenshots.
  addOccurrence(bugId: string, occurrence: BugRecord["reproducedIn"][number], evidence: { displayId: string; screenshots: { file: string; caption: string }[] }): Promise<BugRecord | undefined> {
    return this.#serial(async () => {
      const bugs = await this.#read<BugRecord>(BUGS);
      const bug = bugs.find((b) => b.id === bugId);
      if (!bug) return undefined;
      bug.reproducedIn = [...(bug.reproducedIn ?? []), occurrence];
      bug.attachments = [...(bug.attachments ?? []), ...(await this.#copyEvidence(bugId, evidence))];
      await this.#write(BUGS, bugs);
      return bug;
    });
  }

  // Test data registry per org: qa/test-data/<orgId>.json.
  async listTestData(orgId: string): Promise<TestDataRecord[]> {
    try {
      return JSON.parse(await readFile(this.#testDataPath(orgId), "utf8")) as TestDataRecord[];
    } catch {
      return [];
    }
  }

  addTestData(orgId: string, record: TestDataRecord): Promise<void> {
    return this.#serial(async () => {
      const records = await this.listTestData(orgId);
      records.push(record);
      await mkdir(join(this.root, "test-data"), { recursive: true });
      await writeFileAtomic(this.#testDataPath(orgId), `${JSON.stringify(records, null, 2)}\n`);
    });
  }

  updateTestData(orgId: string, id: string, fields: Record<string, unknown>): Promise<void> {
    return this.#serial(async () => {
      const records = await this.listTestData(orgId);
      const rec = records.find((r) => r.id === id);
      if (!rec) return;
      rec.fields = { ...rec.fields, ...fields };
      await writeFileAtomic(this.#testDataPath(orgId), `${JSON.stringify(records, null, 2)}\n`);
    });
  }

  #testDataPath(orgId: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(orgId)) throw new Error(`Invalid org id ${orgId}`);
    return join(this.root, "test-data", `${orgId}.json`);
  }

  appendExecution(record: ExecutionRecord): Promise<void> {
    return this.#serial(async () => {
      const runs = await this.#read<ExecutionRecord>(EXECUTIONS);
      runs.push(record);
      await this.#write(EXECUTIONS, runs);
      this.#reservedRunIds.delete(record.runId);
    });
  }

  async #copyEvidence(bugId: string, evidence: { displayId: string; screenshots: { file: string; caption: string }[] }) {
    const dir = join(this.root, "bugs", bugId);
    await mkdir(dir, { recursive: true });
    const attachments: { file: string; caption: string }[] = [];
    for (const shot of evidence.screenshots) {
      if (!EVIDENCE_NAME.test(shot.file)) continue;
      const name = `${bugId}_${evidence.displayId}_${shot.file}`;
      const copied = await copyFile(join(this.screenshotsDir(evidence.displayId), shot.file), join(dir, name)).then(() => true, () => false);
      if (copied) attachments.push({ file: `${bugId}/${name}`, caption: shot.caption });
    }
    return attachments;
  }

  async #read<T>(df: DataFile): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(join(this.root, ...df.file), "utf8");
    } catch {
      return [];
    }
    const marker = `window.${df.global} =`;
    const start = text.indexOf(marker);
    if (start < 0) throw new Error(`${df.file.join("/")} does not define window.${df.global}`);
    const json = text.slice(start + marker.length).trim().replace(/;\s*$/, "");
    try {
      return JSON.parse(json) as T[];
    } catch (err) {
      throw new Error(`${df.file.join("/")} is not valid JSON data (${(err as Error).message}); not overwriting it.`, { cause: err });
    }
  }

  async #write(df: DataFile, records: unknown[]): Promise<void> {
    await writeFileAtomic(join(this.root, ...df.file), `${df.header}\nwindow.${df.global} = ${JSON.stringify(records, null, 2)};\n`);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

// "2026-10-01 12:24 IST"-style timestamp in the machine's local time zone, as RMS QA reports use.
export function reportTimestamp(date = new Date()): string {
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  const label = zone === "GMT+5:30" ? "IST" : zone;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${label}`.trim();
}
