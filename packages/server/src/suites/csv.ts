// Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, and line breaks inside quotes
// (multi-line "Steps" cells). The delimiter is detected from the first line: comma, semicolon or tab.
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [",", ";", "\t"].reduce((best, d) => (count(firstLine, d) > count(firstLine, best) ? d : best), ",");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

const BOM = String.fromCharCode(0xfeff);
