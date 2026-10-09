import { readFile } from "node:fs/promises";
import type { Org, SalesforceUser } from "@sfqa/shared";
import { adminSessionPath, myDomainUrl } from "./session.ts";

const API_VERSION = "v62.0";
const RETRY_DELAYS_MS = [2_000, 5_000];

export type ApiErrorCode = "not_connected" | "session_expired" | "request_failed";

export class SalesforceApiError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

// Minimal REST client authenticated with a browser session id (the "sid" cookie of the My Domain host),
// the same way browser tools like Salesforce Inspector call the API from a logged-in session.
export class SalesforceApi {
  readonly baseUrl: string;
  readonly #sid: string;

  constructor(baseUrl: string, sid: string) {
    this.baseUrl = baseUrl;
    this.#sid = sid;
  }

  // Header for raw REST calls made on this session's behalf (call_api).
  authorization(): string {
    return `Bearer ${this.#sid}`;
  }

  #get<T>(path: string): Promise<T> {
    return this.#request<T>("GET", path);
  }

  async #request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    let res: Response | undefined;
    // Network hiccups (connect timeouts to the org's edge) are retried for reads only: a write that
    // timed out may still have been applied, and retrying it could create a duplicate record.
    const attempts = method === "GET" ? RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 1; !res; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.#sid}`,
            Accept: "application/json",
            ...(body !== undefined && { "Content-Type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt >= attempts) {
          const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
          throw new SalesforceApiError("request_failed", `Could not reach ${this.baseUrl} after ${attempt} attempts (${cause}). Check your network connection and try again.`);
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      }
    }
    if (!res.ok) {
      const body = await res.text();
      // Expired or revoked sessions come back as 401, or as 403 Bad_OAuth_Token / INVALID_SESSION_ID.
      if (res.status === 401 || (res.status === 403 && /Bad_OAuth_Token|INVALID_SESSION_ID/i.test(body))) {
        throw new SalesforceApiError("session_expired", "The org admin session has expired.");
      }
      throw new SalesforceApiError("request_failed", `Salesforce API ${res.status}: ${describeApiError(body)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async query<T>(soql: string): Promise<T[]> {
    const data = await this.#get<{ records: T[] }>(`/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
    return data.records;
  }

  async create(sobject: string, fields: Record<string, unknown>): Promise<string> {
    const res = await this.#request<{ id: string }>("POST", `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}`, fields);
    return res.id;
  }

  async update(sobject: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.#request("PATCH", `/services/data/${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`, fields);
  }

  // Identity of the session's user.
  async whoAmI(): Promise<{ userId: string; name: string; username: string; orgId: string }> {
    const info = await this.#get<{ user_id: string; name: string; preferred_username: string; organization_id: string }>(
      "/services/oauth2/userinfo",
    );
    return { userId: info.user_id, name: info.name, username: info.preferred_username, orgId: info.organization_id };
  }
}

// Salesforce errors are [{ message, errorCode, fields }]; show them readably so Claude can correct the call
// (for example a missing required field or an invalid picklist value).
function describeApiError(body: string): string {
  try {
    const errors = JSON.parse(body) as { message?: string; errorCode?: string; fields?: string[] }[];
    if (Array.isArray(errors)) {
      return errors.map((e) => `${e.errorCode ?? "ERROR"}: ${e.message ?? ""}${e.fields?.length ? ` (fields: ${e.fields.join(", ")})` : ""}`).join("; ").slice(0, 1000);
    }
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

export function sidFromCookies(cookies: StoredCookie[], baseUrl: string): string | undefined {
  const host = new URL(baseUrl).hostname;
  return cookies.find((c) => c.name === "sid" && host.endsWith(c.domain.replace(/^\./, "")))?.value;
}

// API client for the org admin's saved session.
export async function adminApi(authDir: string, org: Org): Promise<SalesforceApi> {
  let state: { cookies: StoredCookie[] };
  try {
    state = JSON.parse(await readFile(adminSessionPath(authDir, org.id), "utf8"));
  } catch {
    throw new SalesforceApiError("not_connected", `${org.name} is not connected yet.`);
  }
  const baseUrl = myDomainUrl(org);
  const sid = sidFromCookies(state.cookies, baseUrl);
  if (!sid) throw new SalesforceApiError("session_expired", "The saved admin session has no My Domain session id.");
  return new SalesforceApi(baseUrl, sid);
}

// SOQL string literal escaping; LIKE wildcards are escaped separately where needed.
export const soqlString = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const soqlLike = (value: string) => soqlString(value).replace(/%/g, "\\%").replace(/_/g, "\\_");

interface UserRow {
  Id: string;
  Name: string;
  Username: string;
  IsActive?: boolean;
  Profile?: { Name: string } | null;
  UserRole?: { Name: string } | null;
}

const toUser = (r: UserRow): SalesforceUser => ({
  id: r.Id,
  name: r.Name,
  username: r.Username,
  ...(r.Profile?.Name && { profile: r.Profile.Name }),
  ...(r.UserRole?.Name && { role: r.UserRole.Name }),
});

const USER_FIELDS = "Id, Name, Username, IsActive, Profile.Name, UserRole.Name";

// Active internal users matching a name or username fragment.
export async function searchUsers(api: SalesforceApi, term: string): Promise<SalesforceUser[]> {
  const filter = term.trim()
    ? ` AND (Name LIKE '%${soqlLike(term.trim())}%' OR Username LIKE '%${soqlLike(term.trim())}%')`
    : "";
  const rows = await api.query<UserRow>(
    `SELECT ${USER_FIELDS} FROM User WHERE IsActive = true AND UserType = 'Standard'${filter} ORDER BY Name LIMIT 25`,
  );
  return rows.map(toUser);
}

export async function findUser(api: SalesforceApi, by: { userId?: string; username?: string }): Promise<(SalesforceUser & { active: boolean }) | undefined> {
  const where = by.userId ? `Id = '${soqlString(by.userId)}'` : `Username = '${soqlString(by.username ?? "")}'`;
  const [row] = await api.query<UserRow>(`SELECT ${USER_FIELDS} FROM User WHERE ${where} LIMIT 1`);
  return row && { ...toUser(row), active: row.IsActive !== false };
}
