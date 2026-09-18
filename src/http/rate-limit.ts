import type { RateLimitInfo } from '../core/errors.ts';

/** Maximum plausible epoch-seconds value before we assume epoch milliseconds (13+ digits). */
const EPOCH_MS_THRESHOLD = 1e12;
/** Smallest value we treat as an epoch-seconds timestamp instead of a delta (10+ digits). */
const EPOCH_SECONDS_THRESHOLD = 1e9;
const ONE_DAY_SECONDS = 86_400;

/**
 * Parse rate-limit response headers into a {@link RateLimitInfo}, trying header families in
 * priority order and returning the first that yields anything usable:
 *
 * 1. **IETF** structured fields (draft-ietf-httpapi-ratelimit-headers-11):
 *    `RateLimit: "policy";r=50;t=30` (r = remaining, t = seconds until reset) and
 *    `RateLimit-Policy: "policy";q=100;w=60` (q = quota, w = window seconds). Parsing is lenient:
 *    `key=value` pairs separated by `;`, unknown keys ignored, quoted policy name optional, and
 *    when several policies are advertised the one named by `RateLimit` is used (else the first).
 *    The older dictionary form (`limit=100, remaining=50, reset=30`) is accepted as well.
 * 2. **Legacy** draft-07 triple: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
 *    (seconds until reset).
 * 3. **Vendor** variants: `X-RateLimit-Limit` / `-Remaining` / `-Reset` and `X-Rate-Limit-*`.
 *    `Reset` may be a delta in seconds or an epoch timestamp (seconds when it has 10+ digits and
 *    is not older than a day, milliseconds when it has 13+ digits). `X-RateLimit-Reset-After`
 *    (delta seconds) is preferred over `Reset` when both are present.
 *
 * Returns `null` when nothing parseable is present. Never throws.
 *
 * @param headers Response headers.
 * @param now Current epoch milliseconds, used to turn deltas into absolute `resetAt` values.
 */
export function parseRateLimitHeaders(headers: Headers, now: number): RateLimitInfo | null {
  try {
    return parseIetf(headers, now) ?? parseLegacy(headers, now) ?? parseVendor(headers, now);
  } catch {
    return null;
  }
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * - Non-negative number of seconds (`"120"`, `"1.5"`) → milliseconds.
 * - HTTP-date (`"Wed, 21 Oct 2015 07:28:00 GMT"`) → `max(0, date - now)`.
 * - Anything else (negative, garbage, empty, `null`) → `undefined`.
 *
 * @param value Raw header value, or `null` when the header is absent.
 * @param now Current epoch milliseconds.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

interface StructuredMember {
  /** Bare (non `key=value`) item, e.g. the quoted policy name. */
  name: string | undefined;
  /** Lower-cased parameter names → unquoted values. First occurrence wins. */
  params: Map<string, string>;
}

function parseIetf(headers: Headers, now: number): RateLimitInfo | null {
  const limitHeader = headers.get('ratelimit');
  const policyHeader = headers.get('ratelimit-policy');
  if (limitHeader === null && policyHeader === null) return null;

  let name: string | undefined;
  let remaining: number | undefined;
  let resetAt: number | undefined;
  let limit: number | undefined;

  if (limitHeader !== null) {
    // Merge parameters across members so both the item-with-parameters form and the older
    // dictionary form (`limit=100, remaining=50, reset=30`) are handled.
    const params = new Map<string, string>();
    for (const raw of splitQuoted(limitHeader, ',')) {
      const member = parseMember(raw);
      if (name === undefined) name = member.name;
      for (const [key, val] of member.params) if (!params.has(key)) params.set(key, val);
    }
    remaining = leadingNumber(params.get('r') ?? params.get('remaining'));
    const reset = leadingNumber(params.get('t') ?? params.get('reset'));
    if (reset !== undefined) resetAt = now + Math.round(reset * 1000);
    limit = leadingNumber(params.get('limit') ?? params.get('q'));
  }

  if (policyHeader !== null) {
    const members = splitQuoted(policyHeader, ',').map(parseMember);
    const chosen =
      (name === undefined ? undefined : members.find((m) => m.name === name)) ?? members[0];
    const quota = leadingNumber(chosen?.params.get('q') ?? chosen?.params.get('limit'));
    if (quota !== undefined) limit = quota;
  }

  if (limit === undefined && remaining === undefined && resetAt === undefined) return null;
  const info: RateLimitInfo = { source: 'ietf' };
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (resetAt !== undefined) info.resetAt = resetAt;
  if (policyHeader !== null) info.policy = policyHeader;
  return info;
}

function parseLegacy(headers: Headers, now: number): RateLimitInfo | null {
  const limit = leadingNumber(headers.get('ratelimit-limit'));
  const remaining = leadingNumber(headers.get('ratelimit-remaining'));
  const resetAt = parseReset(headers.get('ratelimit-reset'), now);
  if (limit === undefined && remaining === undefined && resetAt === undefined) return null;
  const info: RateLimitInfo = { source: 'legacy' };
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (resetAt !== undefined) info.resetAt = resetAt;
  return info;
}

function parseVendor(headers: Headers, now: number): RateLimitInfo | null {
  const limit = leadingNumber(firstHeader(headers, ['x-ratelimit-limit', 'x-rate-limit-limit']));
  const remaining = leadingNumber(
    firstHeader(headers, ['x-ratelimit-remaining', 'x-rate-limit-remaining']),
  );
  const resetAfter = leadingNumber(
    firstHeader(headers, ['x-ratelimit-reset-after', 'x-rate-limit-reset-after']),
  );
  const resetAt =
    resetAfter !== undefined
      ? now + Math.round(resetAfter * 1000)
      : parseReset(firstHeader(headers, ['x-ratelimit-reset', 'x-rate-limit-reset']), now);
  if (limit === undefined && remaining === undefined && resetAt === undefined) return null;
  const info: RateLimitInfo = { source: 'vendor' };
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (resetAt !== undefined) info.resetAt = resetAt;
  return info;
}

/**
 * Interpret a reset value: epoch milliseconds (13+ digits), epoch seconds (10+ digits and not
 * older than a day), otherwise a delta in seconds. A 10+ digit value older than a day is neither
 * a plausible delta nor a plausible timestamp and is dropped.
 */
function parseReset(value: string | null, now: number): number | undefined {
  const n = leadingNumber(value);
  if (n === undefined) return undefined;
  if (n >= EPOCH_MS_THRESHOLD) return Math.round(n);
  if (n >= EPOCH_SECONDS_THRESHOLD) {
    return n > now / 1000 - ONE_DAY_SECONDS ? Math.round(n * 1000) : undefined;
  }
  return now + Math.round(n * 1000);
}

function firstHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) return value;
  }
  return null;
}

/** Leading non-negative decimal number of a value (`"100, 100;w=60"` → 100), else undefined. */
function leadingNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse one structured-field member: optional bare item followed by `;key=value` parameters. */
function parseMember(member: string): StructuredMember {
  let name: string | undefined;
  const params = new Map<string, string>();
  for (const segment of splitQuoted(member, ';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) {
      if (name === undefined) name = unquote(segment);
      continue;
    }
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (key === '' || params.has(key)) continue;
    params.set(key, unquote(segment.slice(eq + 1).trim()));
  }
  return { name, params };
}

/** Split on `separator` outside double quotes, trimming and dropping empty parts. */
function splitQuoted(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (quoted && ch === '\\' && i + 1 < value.length) {
      current += ch + value.charAt(i + 1);
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}
