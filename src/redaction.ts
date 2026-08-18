import { createHash } from "node:crypto";

const SESSION_NAME = /^__Secure-next-auth\.session-token(?:\.\d+)?$/i;
const SECRET_KEY = /(authorization|cookie|set-cookie|access[_-]?token|session[_-]?token|sentinel|turnstile|proof|api[_-]?key|secret)/i;
const SECRET_VALUE = /(?:Bearer\s+|(?:__Secure-next-auth\.session-token(?:\.\d+)?|accessToken|access_token|sentinel[_-]?token|turnstile[_-]?token|api[_-]?key)\s*[:=]\s*)([^\s;,"']+)/gi;

export function normalizeSessionCookie(value: string): string {
  let text = String(value || "").trim();
  text = text.replace(/^cookie\s*:\s*/i, "");
  if (!text) return "";
  if (/__Secure-next-auth\.session-token(?:\.\d+)?\s*=/.test(text)) return text;
  return `__Secure-next-auth.session-token=${text}`;
}

export function cookieKey(value: string): string {
  return createHash("sha256").update(normalizeSessionCookie(value)).digest("hex").slice(0, 16);
}

/** Merge rotated session-token cookies while retaining unrelated cookie attributes. */
export function mergeRotatedCookie(original: string, setCookie: string | string[] | null | undefined): string | null {
  if (!setCookie) return null;
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const rotated = new Map<string, string>();
  for (const header of values) {
    for (const match of header.matchAll(/(__Secure-next-auth\.session-token(?:\.\d+)?)=([^;,\s]+)/gi)) {
      rotated.set(match[1], match[2]);
    }
  }
  if (!rotated.size) return null;
  const input = normalizeSessionCookie(original);
  if (!input.includes("=")) return [...rotated].map(([k, v]) => `${k}=${v}`).join("; ");
  const parts = input.split(/;\s*/).filter(Boolean);
  const output: string[] = [];
  let hadSession = false;
  for (const part of parts) {
    const split = part.indexOf("=");
    const name = (split < 0 ? part : part.slice(0, split)).trim();
    if (SESSION_NAME.test(name)) {
      hadSession = true;
      continue;
    }
    output.push(part);
  }
  for (const [name, token] of rotated) output.push(`${name}=${token}`);
  return !hadSession || output.join("; ") !== input ? output.join("; ") : null;
}

export function redactString(input: string): string {
  let result = String(input ?? "");
  result = result.replace(SECRET_VALUE, (_all, _value) => `${_all.slice(0, _all.indexOf(_value))}[REDACTED]`);
  result = result.replace(/(cookie\s*:\s*)([^\n]+)/gi, "$1[REDACTED]");
  result = result.replace(/(set-cookie\s*:\s*)([^\n]+)/gi, "$1[REDACTED]");
  return result;
}

export function redact<T>(value: T, key?: string): T {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = SECRET_KEY.test(childKey) ? "[REDACTED]" : redact(childValue, childKey);
    }
    return output as T;
  }
  return value;
}

export function safeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(entries.map(([key, value]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactString(value)]));
}

export function safeErrorMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

export function credentialSafe(value: unknown): boolean {
  const text = JSON.stringify(value);
  return !/(?:Bearer\s+[A-Za-z0-9._-]{8,}|__Secure-next-auth\.session-token\s*=\s*[^\s;,]+)/i.test(text);
}
