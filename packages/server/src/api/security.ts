import { createHash, timingSafeEqual } from "node:crypto";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

// Rejects DNS-rebinding requests, where a hostile site resolves its own domain to 127.0.0.1.
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOCAL_HOSTNAMES.has(host.replace(/:\d+$/, "").toLowerCase());
}

// Browsers attach Origin to cross-site requests; only the extension (or non-browser clients) may call us.
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin.startsWith("chrome-extension://");
}

export function tokensMatch(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/i, "$1[redacted]");
}
