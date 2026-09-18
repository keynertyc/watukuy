/** Header names (lower-case) that are always masked in logs and spans. */
export const DEFAULT_REDACTED_HEADERS: ReadonlyArray<string> = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
];

/** Placeholder written in place of a redacted header value. */
export const REDACTED_VALUE = '***';

/**
 * Copy headers into a plain object, masking sensitive values with `'***'` (see docs/http-helper.md).
 *
 * Always masks {@link DEFAULT_REDACTED_HEADERS}; `extra` adds more names. Matching is
 * case-insensitive. Original key casing is preserved for record input; `Headers` input yields
 * lower-case names (as the platform iterates them). The input is never mutated.
 *
 * @param headers Request or response headers.
 * @param extra Additional header names to mask.
 */
export function redactHeaders(
  headers: Record<string, string> | Headers,
  extra?: string[],
): Record<string, string> {
  const blocked = new Set<string>(DEFAULT_REDACTED_HEADERS);
  for (const name of extra ?? []) blocked.add(name.trim().toLowerCase());

  const out: Record<string, string> = {};
  const entries: Iterable<[string, string]> =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) {
    out[name] = blocked.has(name.toLowerCase()) ? REDACTED_VALUE : value;
  }
  return out;
}
