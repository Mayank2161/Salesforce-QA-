import { strToU8, zipSync } from "fflate";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => String.fromCharCode(65 + i);

// Builds a minimal real .xlsx (one sheet, inline strings) for parser tests.
export function makeXlsx(rows: (string | number | null)[][], sheetName = "Test Cases"): Buffer {
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    if (v === null || v === "") return "";
    const ref = `${colName(c)}${r + 1}`;
    return typeof v === "number"
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }).join("")}</row>`).join("");

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
  };
  return Buffer.from(zipSync(files));
}
