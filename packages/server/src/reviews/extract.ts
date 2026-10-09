import { unzipSync, strFromU8 } from "fflate";
import readXlsxFile from "read-excel-file/node";
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_REQUIREMENTS_BYTES } from "@sfqa/shared";
import { parseCsv } from "../suites/csv.ts";

export class RequirementsFileError extends Error {
  override name = "RequirementsFileError";
}

// Everything Claude reads goes into its prompt, so the document has to fit in it with room to spare.
export const MAX_REQUIREMENTS_CHARS = 400_000;

export interface RequirementsText {
  text: string;
  pages?: number;
}

// Plain text of a BRD or requirement sheet, keeping the structure that matters for tracing:
// headings, list items, table rows and requirement IDs.
export async function extractRequirements(fileName: string, data: Buffer): Promise<RequirementsText> {
  if (data.length === 0) throw new RequirementsFileError("The requirements file is empty.");
  if (data.length > MAX_REQUIREMENTS_BYTES) throw new RequirementsFileError("The requirements file is larger than 10 MB.");
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));

  let result: RequirementsText;
  switch (ext) {
    case ".txt":
    case ".md":
      result = { text: data.toString("utf8") };
      break;
    case ".csv":
      result = { text: rowsText(parseCsv(data.toString("utf8"))) };
      break;
    case ".xlsx":
      result = { text: await xlsxText(data) };
      break;
    case ".docx":
      result = { text: docxText(data) };
      break;
    case ".pdf":
      result = await pdfText(data);
      break;
    case ".doc":
      throw new RequirementsFileError("Old Word .doc files are not supported. In Word, use File > Save As > Word Document (.docx), or save as PDF.");
    case ".xls":
      throw new RequirementsFileError("Old Excel .xls files are not supported. In Excel, use File > Save As > Excel Workbook (.xlsx).");
    default:
      throw new RequirementsFileError(`Unsupported file type "${ext || fileName}". Upload a PDF, Word .docx, Excel .xlsx, .csv, .txt or .md file.`);
  }

  const text = result.text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.replace(/\s|-+ Page \d+ -+/g, "").length < 40) {
    throw new RequirementsFileError(ext === ".pdf"
      ? "No readable text was found in this PDF. It may be a scanned image; upload the Word version or a PDF with selectable text."
      : "No readable text was found in the requirements file.");
  }
  if (text.length > MAX_REQUIREMENTS_CHARS) {
    throw new RequirementsFileError(`The requirements document is too long to review in one go (${Math.round(text.length / 1000)}k characters, limit ${MAX_REQUIREMENTS_CHARS / 1000}k). Upload only the sections these test cases cover.`);
  }
  return { ...result, text };
}

function rowsText(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.trim()).filter(Boolean).join(" | ")).filter(Boolean).join("\n");
}

async function xlsxText(data: Buffer): Promise<string> {
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = await readXlsxFile(data);
  } catch (err) {
    throw new RequirementsFileError(`This is not a readable Excel .xlsx file (${(err as Error).message}).`, { cause: err });
  }
  return sheets.map((s) => `## Sheet: ${s.sheet}\n${rowsText(s.data.map((r) => r.map(cellText)))}`).join("\n\n");
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

async function pdfText(data: Buffer): Promise<RequirementsText> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    return { pages: totalPages, text: text.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join("\n\n") };
  } catch (err) {
    throw new RequirementsFileError(`This is not a readable PDF file (${(err as Error).message}).`, { cause: err });
  }
}

// --- Word .docx: word/document.xml inside the zip ---------------------------------------------

function docxText(data: Buffer): string {
  let xml: string;
  try {
    const files = unzipSync(new Uint8Array(data), { filter: (f) => f.name === "word/document.xml" });
    const doc = files["word/document.xml"];
    if (!doc) throw new Error("word/document.xml is missing");
    xml = strFromU8(doc);
  } catch (err) {
    throw new RequirementsFileError(`This is not a readable Word .docx file (${(err as Error).message}).`, { cause: err });
  }
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  // Tables first, one line per row with cells separated by " | ", so requirement matrices stay readable.
  const withTables = body.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (tbl) =>
    `<w:p><w:r><w:t>${escapeXml((tbl.match(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g) ?? [])
      .map((tr) => (tr.match(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => paragraphs(tc).join(" / ")).join(" | "))
      .join(""))}</w:t></w:r></w:p>`);
  return paragraphs(withTables).join("\n").replace(//g, "\n");
}

function paragraphs(xml: string): string[] {
  return xml.split(/<\/w:p>/).map((p) => {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    const level = style === "Title" ? 1 : Number(/^heading\s?(\d)$/i.exec(style)?.[1] ?? 0);
    const text = decodeXml(p
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(?:br|cr)\/>/g, "\n")
      .replace(/<[^>]+>/g, ""))
      .trim();
    if (!text) return "";
    if (level) return `${"#".repeat(level)} ${text}`;
    if (/<w:numPr\b/.test(p)) return `- ${text}`;
    return text;
  }).filter(Boolean);
}

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'"
      : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
