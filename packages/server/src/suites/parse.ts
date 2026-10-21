import readXlsxFile from "read-excel-file/node";
import type { ParsedSuite, Persona, SuiteCase } from "@sfqa/shared";
import { parseCsv } from "./csv.ts";

export class SuiteFileError extends Error {
  override name = "SuiteFileError";
}

// Canonical columns and the header spellings accepted for each (compared lowercased, letters/digits only).
const COLUMNS = {
  tcId: { label: "TC ID", aliases: ["tcid", "testcaseid", "tcno", "testid", "caseid", "testcaseno", "testcasenumber", "id"] },
  sprint: { label: "Sprint", aliases: ["sprint"] },
  story: { label: "Story", aliases: ["story", "userstory", "storyid", "jirastoryid", "jirastory", "jiraid", "storykey"] },
  module: { label: "Module", aliases: ["module", "object", "area", "feature", "component"] },
  title: { label: "Title", aliases: ["title", "testcasetitle", "testcasename", "testcase", "scenario", "testscenario", "summary"] },
  persona: { label: "Persona", aliases: ["persona", "userpersona", "user", "role", "userrole"] },
  description: { label: "Description", aliases: ["description", "desc", "objective", "testobjective", "testcasedescription"] },
  prereq: { label: "Pre-Req", aliases: ["prereq", "prerequisite", "prerequisites", "precondition", "preconditions", "prereqs"] },
  type: { label: "Type", aliases: ["type", "testtype", "testcasetype"] },
  priority: { label: "Priority", aliases: ["priority"] },
  testData: { label: "Test Data", aliases: ["testdata", "data", "inputdata"] },
  steps: { label: "Steps", aliases: ["steps", "teststeps", "stepstoexecute", "procedure", "testprocedure", "stepstoreproduce"] },
  expected: { label: "Expected Result", aliases: ["expectedresult", "expectedresults", "expected", "expectedoutcome", "expectedbehaviour", "expectedbehavior"] },
} as const;
type Column = keyof typeof COLUMNS;

export const REQUIRED_COLUMNS: Column[] = ["tcId", "title", "steps", "expected"];

// Results of a previous execution are not instructions for this one.
const IGNORED = new Set(["actualresult", "actualresults", "actual", "status", "result", "executionstatus", "teststatus", "passfail", "comments", "remarks", "executedby", "executedon"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function columnFor(header: string): Column | undefined {
  const key = norm(header);
  return (Object.keys(COLUMNS) as Column[]).find((c) => (COLUMNS[c].aliases as readonly string[]).includes(key));
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Reads the file into rows of strings. The header row is found later, so title rows above it are fine.
export async function readRows(fileName: string, data: Buffer): Promise<{ rows: string[][]; sheet?: string }> {
  if (data.length === 0) throw new SuiteFileError("The file is empty.");
  if (data.length > MAX_FILE_BYTES) throw new SuiteFileError("The file is larger than 5 MB.");
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));

  if (ext === ".csv") return { rows: parseCsv(data.toString("utf8")) };
  if (ext === ".xls") throw new SuiteFileError("Old Excel .xls files are not supported. In Excel, use File > Save As > Excel Workbook (.xlsx).");
  if (ext !== ".xlsx") throw new SuiteFileError(`Unsupported file type "${ext || fileName}". Upload an Excel .xlsx or a .csv file.`);

  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = await readXlsxFile(data);
  } catch (err) {
    throw new SuiteFileError(`This is not a readable Excel .xlsx file (${(err as Error).message}).`, { cause: err });
  }
  // Use the first sheet that has a TC ID header; otherwise the first sheet, which yields "missing columns".
  const asRows = (rows: unknown[][]) => rows.map((r) => r.map(cellText));
  for (const s of sheets) {
    const rows = asRows(s.data);
    if (findHeaderRow(rows) >= 0) return { rows, sheet: s.sheet };
  }
  return { rows: sheets[0] ? asRows(sheets[0].data) : [], sheet: sheets[0]?.sheet };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

// The header row is the first of the top 10 rows with a TC ID column.
function findHeaderRow(rows: string[][]): number {
  return rows.slice(0, 10).findIndex((r) => r.some((cell) => columnFor(cell) === "tcId"));
}

// Matches the file's Persona text to a configured persona, trying in order and taking the first tier
// with exactly one match: exact persona name/id, exact profile/user name, then partial matches of the
// same ("Sales User" -> persona "Sales"). Persona names come first because several personas can share
// a profile (two users on the "Sales" profile).
export function matchPersona(label: string, personas: Persona[]): Persona | undefined {
  const key = norm(label);
  if (!key) return undefined;
  const own = (p: Persona) => [p.id, p.name].map(norm);
  const user = (p: Persona) => [p.profile, p.userFullName].filter(Boolean).map((k) => norm(k!));
  const exact = (keys: (p: Persona) => string[]) => personas.filter((p) => keys(p).includes(key));
  const partial = (keys: (p: Persona) => string[]) =>
    personas.filter((p) => keys(p).some((k) => k.length >= 3 && (key.includes(k) || k.includes(key))));
  for (const tier of [exact(own), exact(user), partial(own), partial(user)]) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) return undefined; // ambiguous: let the user pick
  }
  return undefined;
}

// Persona cell -> persona names, in order. Separators: comma, semicolon, "+", "&", arrows, "then", new line.
// ("and" is not one: persona names like "Sales and Marketing" contain it.)
export function splitPersonas(cell: string): string[] {
  return cell.split(/\s*(?:,|;|\+|&|->|→|=>|\bthen\b|\n)\s*/i).map((s) => s.trim()).filter(Boolean);
}

export function toSuite(fileName: string, rows: string[][], personas: Persona[], sheet?: string): ParsedSuite {
  const headerIndex = findHeaderRow(rows);
  const header = headerIndex >= 0 ? rows[headerIndex]! : (rows[0] ?? []);
  const columns = header.map((h) => h.trim()).filter(Boolean);

  const index = new Map<Column, number>();
  const extras: { label: string; i: number }[] = [];
  header.forEach((h, i) => {
    const col = columnFor(h);
    if (col && !index.has(col)) index.set(col, i);
    else if (!col && h.trim() && !IGNORED.has(norm(h))) extras.push({ label: h.trim(), i });
  });

  const missingColumns = REQUIRED_COLUMNS.filter((c) => !index.has(c)).map((c) => COLUMNS[c].label);
  if (missingColumns.length > 0) return { fileName, sheet, columns, missingColumns, cases: [] };

  const cases: SuiteCase[] = [];
  const seen = new Map<string, number>();
  rows.slice(headerIndex + 1).forEach((cells, offset) => {
    if (cells.every((c) => !c.trim())) return; // blank row
    const rowNumber = headerIndex + offset + 2;
    const get = (c: Column) => (index.has(c) ? (cells[index.get(c)!] ?? "").trim() : "");

    const tcId = get("tcId");
    const title = get("title") || get("description").split("\n")[0]!.slice(0, 200) || "(no title)";
    const personaLabel = get("persona");
    // "Sales User, Sales Manager" or "Sales -> Manager": a multi-persona test, first persona first.
    const labels = splitPersonas(personaLabel);
    const persona = labels[0] ? matchPersona(labels[0], personas) : undefined;
    const otherPersonas = labels.slice(1).map((l) => ({ label: l, persona: matchPersona(l, personas) }));

    let error: string | undefined;
    if (!tcId) error = "No TC ID in this row.";
    else if (!get("steps")) error = "No Steps in this row.";
    else if (!get("expected")) error = "No Expected Result in this row.";
    else if (labels.length > 4) error = "A test can involve at most 4 personas.";
    else if (otherPersonas.some((e) => !e.persona)) {
      error = `Persona ${otherPersonas.filter((e) => !e.persona).map((e) => `"${e.label}"`).join(", ")} does not match a persona in this org. Add it in the panel, then upload the file again.`;
    }

    let warning: string | undefined;
    if (tcId && seen.has(tcId)) warning = `Duplicate TC ID (also in row ${seen.get(tcId)}).`;
    if (labels[0] && !persona) {
      const p = `Persona "${labels[0]}" does not match a persona in this org; the default persona will be used.`;
      warning = warning ? `${warning} ${p}` : p;
    }
    const extraPersonaIds = [...new Set(otherPersonas.map((e) => e.persona?.id).filter((id): id is string => Boolean(id) && id !== persona?.id))];
    if (tcId && !seen.has(tcId)) seen.set(tcId, rowNumber);

    cases.push({
      row: rowNumber,
      ...(tcId && { tcId }),
      title,
      ...(get("module") && { module: get("module") }),
      ...(personaLabel && { personaLabel }),
      ...(persona && { personaId: persona.id }),
      ...(extraPersonaIds.length && { extraPersonaIds }),
      body: caseBody(get, extras.map((e) => ({ label: e.label, value: (cells[e.i] ?? "").trim() }))),
      ...(error && { error }),
      ...(warning && { warning }),
    });
  });
  return { fileName, sheet, columns, missingColumns, cases };
}

// The row as labelled lines, in the order a tester reads a test case; Steps and Expected last.
function caseBody(get: (c: Column) => string, extras: { label: string; value: string }[]): string {
  const line = (c: Column) => (get(c) ? `${COLUMNS[c].label}: ${get(c)}` : undefined);
  const block = (c: Column) => (get(c) ? `${COLUMNS[c].label}:\n${get(c)}` : undefined);
  return [
    line("tcId"), line("sprint"), line("story"), line("module"), line("title"), line("persona"),
    line("description"), block("prereq"), line("type"), line("priority"), block("testData"),
    ...extras.filter((e) => e.value).map((e) => `${e.label}: ${e.value}`),
    block("steps"), block("expected"),
  ].filter(Boolean).join("\n");
}
