import type { TimestampCursor, TimestampCursorConfig } from '../core/cursor-types.ts';
import { parseDuration } from '../core/duration.ts';
import { ConfigError } from '../core/errors.ts';
import { getPath } from './path.ts';
import { isRecord, malformedCursor, parseCursorJson } from './shared.ts';
import type { AdvanceInput, AdvanceResult, CursorStrategy } from './types.ts';

const EPOCH_SECONDS = /^\d{10}$/;
const EPOCH_MILLIS = /^\d{13}$/;

function defaultParse(raw: string): number {
  if (EPOCH_SECONDS.test(raw)) return Number(raw) * 1000;
  if (EPOCH_MILLIS.test(raw)) return Number(raw);
  return Date.parse(raw);
}

/**
 * Parse the API's timestamp string to epoch milliseconds using `cfg.parse`, or the default:
 * 10 all-digit characters are epoch seconds, 13 are epoch milliseconds, anything else goes
 * through `Date.parse`.
 *
 * @throws {ConfigError} when the result is not a finite number; the message includes `raw` and
 * the field name so a wrong `field` or missing `parse` is easy to spot.
 */
export function parseTimestamp(cfg: TimestampCursorConfig, raw: string): number {
  const ms = cfg.parse ? cfg.parse(raw) : defaultParse(raw);
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new ConfigError(
      `timestamp cursor: cannot parse ${JSON.stringify(raw)} (field '${cfg.field}') to epoch milliseconds; set cursor.parse for this format`,
    );
  }
  return ms;
}

/** Like {@link parseTimestamp} but returns `null` instead of throwing. */
function tryParseTimestamp(cfg: TimestampCursorConfig, raw: string): number | null {
  try {
    const ms = cfg.parse ? cfg.parse(raw) : defaultParse(raw);
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Format epoch milliseconds back into the API's string form using `cfg.format`, or the default:
 * the same digit form as `sample` (10 digits → epoch seconds, 13 → epoch milliseconds, both
 * floored so the result is never later than `epochMs`), otherwise ISO 8601.
 *
 * Only used for `overlap` arithmetic; the persisted cursor is always the server's own string.
 */
export function formatTimestamp(
  cfg: TimestampCursorConfig,
  epochMs: number,
  sample: string | null,
): string {
  if (cfg.format) return cfg.format(epochMs, sample);
  if (sample !== null && EPOCH_SECONDS.test(sample)) return String(Math.floor(epochMs / 1000));
  if (sample !== null && EPOCH_MILLIS.test(sample)) return String(Math.floor(epochMs));
  return new Date(epochMs).toISOString();
}

/**
 * Compare two timestamp strings by their parsed instants: negative when `a` is earlier, positive
 * when later, `0` when equal.
 *
 * @throws {ConfigError} when either string cannot be parsed.
 */
export function compareTimestamps(cfg: TimestampCursorConfig, a: string, b: string): number {
  const x = parseTimestamp(cfg, a);
  const y = parseTimestamp(cfg, b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/**
 * The server's own string for a timestamp field. Strings are used verbatim; finite numbers are
 * stringified (so epoch seconds/milliseconds work); `Date`s become ISO strings; anything else
 * counts as missing.
 */
function fieldString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

function tieOf(item: unknown, field: string): string | null {
  const value = getPath(item, field);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

/** Larger of two tie-break values by UTF-16 code units; `null` loses to anything. */
function maxString(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function advance(
  cfg: TimestampCursorConfig,
  cursor: TimestampCursor,
  input: AdvanceInput,
): AdvanceResult<TimestampCursor> {
  const done = input.hasMore !== true;

  if (typeof input.pageCursor === 'string') {
    // Explicit watermark from fetch(): trust it, keep every item.
    return { cursor: { value: input.pageCursor, tieBreak: null }, done, items: input.items };
  }

  const lagMs = cfg.lag === undefined ? 0 : parseDuration(cfg.lag, 'cursor.lag');
  const cutoff = input.now - lagMs;
  const tieField = cfg.tieBreak ?? null;

  const kept: unknown[] = [];
  let maxRaw: string | null = null;
  let maxMs = Number.NEGATIVE_INFINITY;
  let maxTie: string | null = null;

  for (const item of input.items) {
    const raw = fieldString(getPath(item, cfg.field));
    const ms = raw === null ? null : tryParseTimestamp(cfg, raw);
    if (ms === null) {
      // Missing or unparseable field: still diffed, never moves the watermark.
      kept.push(item);
      continue;
    }
    if (ms > cutoff) continue; // Too fresh for `lag`; re-fetched next cycle.
    kept.push(item);
    if (ms > maxMs) {
      maxMs = ms;
      maxRaw = raw;
      maxTie = tieField === null ? null : tieOf(item, tieField);
    } else if (ms === maxMs && tieField !== null) {
      maxTie = maxString(maxTie, tieOf(item, tieField));
    }
  }

  // Hand back the caller's array untouched when lag dropped nothing.
  const items = kept.length === input.items.length ? input.items : kept;

  if (maxRaw === null) return { cursor, done, items };

  const currentMs = cursor.value === null ? null : parseTimestamp(cfg, cursor.value);
  if (currentMs === null || maxMs > currentMs) {
    return { cursor: { value: maxRaw, tieBreak: maxTie }, done, items };
  }
  if (maxMs === currentMs && tieField !== null) {
    return {
      cursor: { value: cursor.value, tieBreak: maxString(cursor.tieBreak, maxTie) },
      done,
      items,
    };
  }
  return { cursor, done, items };
}

/**
 * `updated_since`-style APIs (see docs/cursors.md). The cursor is the keyset `(value, tieBreak)`:
 *
 * - `advance` sets `value` to the **original string** of the largest `field` among the page's
 *   items (never re-serialized), and `tieBreak` to the largest tie-break value among items that
 *   share that timestamp. On a tie with the current watermark only `tieBreak` grows, so items
 *   sharing one timestamp across a page boundary are never skipped.
 * - Items whose `field` is newer than `now - lag` are dropped from the page and from the
 *   watermark; they come back next cycle. Items with a missing/unparseable field are kept for
 *   the diff but ignored for the watermark.
 * - A string `Page.cursor` overrides the derived watermark (`tieBreak` becomes `null`) and no
 *   lag filtering applies.
 * - `forFetch` applies `overlap`: the value handed to `fetch` is `value - overlap` formatted in
 *   the same shape as the stored string, with `tieBreak: null`.
 * - `done` is `true` unless the page says `hasMore: true`.
 *
 * Tie-break values are compared as strings, which is safe: the chosen value is always one that
 * was seen, so a lexicographically "smaller" numeric id can only cause re-fetches (suppressed by
 * the identity/version map), never skips.
 */
export const timestampStrategy: CursorStrategy<TimestampCursorConfig, TimestampCursor> = {
  name: 'timestamp',

  initial(cfg) {
    return { value: cfg.initial, tieBreak: null };
  },

  serialize(_cfg, cursor) {
    return JSON.stringify({ value: cursor.value, tieBreak: cursor.tieBreak });
  },

  deserialize(_cfg, raw) {
    const parsed = parseCursorJson('timestamp', raw);
    if (
      !isRecord(parsed) ||
      !(typeof parsed.value === 'string' || parsed.value === null) ||
      !(typeof parsed.tieBreak === 'string' || parsed.tieBreak === null)
    ) {
      throw malformedCursor('timestamp', raw, '{ value: string | null, tieBreak: string | null }');
    }
    return { value: parsed.value, tieBreak: parsed.tieBreak };
  },

  forFetch(cfg, cursor) {
    const overlapMs = cfg.overlap === undefined ? 0 : parseDuration(cfg.overlap, 'cursor.overlap');
    if (overlapMs <= 0 || cursor.value === null) return cursor;
    const ms = parseTimestamp(cfg, cursor.value);
    return { value: formatTimestamp(cfg, ms - overlapMs, cursor.value), tieBreak: null };
  },

  advance,

  onCycleComplete(_cfg, cursor) {
    return cursor;
  },

  lagMs(cfg, cursor, now) {
    if (cursor.value === null) return null;
    const ms = tryParseTimestamp(cfg, cursor.value);
    return ms === null ? null : now - ms;
  },

  reached(cfg, cursor, target) {
    if (target.value === null) return true;
    if (cursor.value === null) return false;
    return parseTimestamp(cfg, cursor.value) >= parseTimestamp(cfg, target.value);
  },

  fromRaw(_cfg, raw) {
    return { value: raw, tieBreak: null };
  },
};
