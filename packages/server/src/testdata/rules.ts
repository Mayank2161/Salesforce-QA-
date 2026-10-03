// Guard rails for test-data setup through the org admin's API access.
// Claude may read any data, but may only create business records and only edit records it created.

const STANDARD_OBJECTS = new Set([
  "Account", "Contact", "Lead", "Opportunity", "OpportunityContactRole", "OpportunityLineItem",
  "Case", "Task", "Event", "Campaign", "CampaignMember", "Contract", "Order", "OrderItem",
  "Asset", "Product2", "Pricebook2", "PricebookEntry", "Quote", "QuoteLineItem", "Note", "ContentNote",
]);

// Custom objects end in __c; metadata, events, shares, history and feeds are not test data.
const CUSTOM_OBJECT = /^[A-Za-z][A-Za-z0-9_]*__c$/;

export function isAllowedSObject(name: string): boolean {
  return STANDARD_OBJECTS.has(name) || CUSTOM_OBJECT.test(name);
}

export function allowedObjectsHint(): string {
  return `${[...STANDARD_OBJECTS].join(", ")}, and custom objects (Name__c)`;
}

const MAX_ROWS = 200;

// Accepts a single read-only SELECT and makes sure it is bounded.
export function checkedSoql(input: string): string {
  const soql = input.trim().replace(/\s+/g, " ");
  if (!/^select\s/i.test(soql)) throw new Error("Only SELECT queries are allowed.");
  if (soql.includes(";")) throw new Error("Send one query at a time, without a semicolon.");
  if (/\bfor\s+(update|view|reference)\b/i.test(soql)) throw new Error("FOR UPDATE/VIEW/REFERENCE is not allowed.");
  const limit = /\blimit\s+(\d+)\s*(offset\s+\d+\s*)?$/i.exec(soql);
  if (!limit) return `${soql} LIMIT 50`;
  if (Number(limit[1]) > MAX_ROWS) throw new Error(`LIMIT may be at most ${MAX_ROWS}.`);
  return soql;
}

// Field names and values for create/update: plain JSON scalars only, no nested objects.
export function checkedFields(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a valid field API name.`);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Field ${name} must be a string, number, boolean or null.`);
    }
    out[name] = value as string | number | boolean | null;
  }
  if (Object.keys(out).length === 0) throw new Error("Provide at least one field.");
  return out;
}

// Salesforce returns an "attributes" block on every row; drop it to keep tool results compact.
export function compactRows(rows: unknown[]): unknown[] {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) if (k !== "attributes") out[k] = strip(v);
      return out;
    }
    return value;
  };
  return rows.map(strip);
}
