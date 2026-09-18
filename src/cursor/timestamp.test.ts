import { describe, expect, it } from 'vitest';
import type { TimestampCursor, TimestampCursorConfig } from '../core/cursor-types.ts';
import { ConfigError } from '../core/errors.ts';
import {
  compareTimestamps,
  formatTimestamp,
  parseTimestamp,
  timestampStrategy as s,
} from './timestamp.ts';
import type { AdvanceInput } from './types.ts';

const T0 = Date.parse('2024-05-01T10:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function cfg(overrides: Partial<TimestampCursorConfig> = {}): TimestampCursorConfig {
  return { strategy: 'timestamp', field: 'updatedAt', initial: null, ...overrides };
}

function page(items: unknown[], extra: Partial<AdvanceInput> = {}): AdvanceInput {
  return { items, pageCursor: undefined, hasMore: undefined, now: T0 + 3_600_000, ...extra };
}

const cursor = (value: string | null, tieBreak: string | null = null): TimestampCursor => ({
  value,
  tieBreak,
});

describe('parseTimestamp', () => {
  const c = cfg();
  it('handles epoch seconds, epoch millis, and ISO strings by default', () => {
    expect(parseTimestamp(c, '1714557600')).toBe(1714557600_000);
    expect(parseTimestamp(c, '1714557600123')).toBe(1714557600123);
    expect(parseTimestamp(c, '2024-05-01T10:00:00Z')).toBe(T0);
    expect(parseTimestamp(c, '2024-05-01T12:00:00+02:00')).toBe(T0);
  });

  it('uses cfg.parse when provided', () => {
    const custom = cfg({ parse: (raw) => Number(raw.replace('t=', '')) });
    expect(parseTimestamp(custom, 't=5')).toBe(5);
  });

  it('throws a ConfigError naming the raw value and field when unparseable', () => {
    expect(() => parseTimestamp(c, 'yesterday')).toThrow(ConfigError);
    expect(() => parseTimestamp(c, 'yesterday')).toThrow(/"yesterday".*'updatedAt'/);
    expect(() => parseTimestamp(cfg({ parse: () => Number.NaN }), 'x')).toThrow(ConfigError);
    expect(() => parseTimestamp(cfg({ parse: () => Number.POSITIVE_INFINITY }), 'x')).toThrow(
      ConfigError,
    );
  });
});

describe('formatTimestamp', () => {
  const c = cfg();
  it('mirrors the digit form of the sample, flooring', () => {
    expect(formatTimestamp(c, 1714557600_000, '1714557600')).toBe('1714557600');
    expect(formatTimestamp(c, 1714557600_999, '1714557600')).toBe('1714557600');
    expect(formatTimestamp(c, 1714557600_123, '1714557600123')).toBe('1714557600123');
    expect(formatTimestamp(c, 1714557600_123.7, '1714557600123')).toBe('1714557600123');
  });

  it('falls back to ISO 8601 for other samples or no sample', () => {
    expect(formatTimestamp(c, T0, '2024-05-01T12:00:00+02:00')).toBe('2024-05-01T10:00:00.000Z');
    expect(formatTimestamp(c, T0, null)).toBe('2024-05-01T10:00:00.000Z');
  });

  it('uses cfg.format when provided', () => {
    const custom = cfg({ format: (ms, sample) => `${sample ?? '-'}:${ms}` });
    expect(formatTimestamp(custom, 5, 'x')).toBe('x:5');
  });
});

describe('compareTimestamps', () => {
  it('orders by parsed instant across formats', () => {
    const c = cfg();
    expect(compareTimestamps(c, '2024-05-01T10:00:00Z', '1714557600')).toBe(0);
    expect(compareTimestamps(c, '2024-05-01T09:00:00Z', '1714557600')).toBe(-1);
    expect(compareTimestamps(c, '1714557601', '2024-05-01T10:00:00Z')).toBe(1);
  });
});

describe('timestampStrategy', () => {
  it('has the strategy name', () => {
    expect(s.name).toBe('timestamp');
  });

  it('initial uses cfg.initial with no tie-break', () => {
    expect(s.initial(cfg())).toEqual({ value: null, tieBreak: null });
    expect(s.initial(cfg({ initial: '2024-01-01T00:00:00Z' }))).toEqual({
      value: '2024-01-01T00:00:00Z',
      tieBreak: null,
    });
  });

  it('serialize/deserialize round-trip and reject malformed input', () => {
    const c = cfg();
    for (const cur of [cursor(null), cursor('x'), cursor('x', 'id-9')]) {
      const raw = s.serialize(c, cur);
      expect(typeof raw).toBe('string');
      expect(JSON.parse(raw)).toEqual(cur);
      expect(s.deserialize(c, raw)).toEqual(cur);
    }
    expect(() => s.deserialize(c, 'not json')).toThrow(TypeError);
    expect(() => s.deserialize(c, '{"value":1,"tieBreak":null}')).toThrow(TypeError);
    expect(() => s.deserialize(c, '{"value":"x"}')).toThrow(TypeError);
    expect(() => s.deserialize(c, '[]')).toThrow(TypeError);
  });

  describe('advance', () => {
    it('moves the watermark to the max field, preserving the original string form', () => {
      const c = cfg();
      const items = [
        { id: 1, updatedAt: '2024-05-01T10:00:02+00:00' },
        { id: 2, updatedAt: '2024-05-01T12:00:05+02:00' },
        { id: 3, updatedAt: '2024-05-01T10:00:03Z' },
      ];
      const out = s.advance(c, s.initial(c), page(items));
      expect(out.cursor).toEqual({ value: '2024-05-01T12:00:05+02:00', tieBreak: null });
      expect(out.done).toBe(true);
      expect(out.items).toBe(items);
    });

    it('never moves the watermark backwards for out-of-order pages', () => {
      const c = cfg();
      const current = cursor(iso(10_000));
      const out = s.advance(c, current, page([{ updatedAt: iso(5_000) }, { updatedAt: iso(1) }]));
      expect(out.cursor).toBe(current);
      expect(out.items).toHaveLength(2);
    });

    it('leaves the cursor untouched on an empty page and reports done', () => {
      const c = cfg();
      const current = cursor(iso(0), 'a');
      const out = s.advance(c, current, page([]));
      expect(out.cursor).toBe(current);
      expect(out.done).toBe(true);
      expect(out.items).toEqual([]);
    });

    it('done follows hasMore', () => {
      const c = cfg();
      expect(s.advance(c, s.initial(c), page([], { hasMore: true })).done).toBe(false);
      expect(s.advance(c, s.initial(c), page([], { hasMore: false })).done).toBe(true);
      expect(s.advance(c, s.initial(c), page([], { hasMore: undefined })).done).toBe(true);
    });

    it('picks the largest tie-break among items sharing the max timestamp', () => {
      const c = cfg({ tieBreak: 'id' });
      const items = [
        { id: 'b', updatedAt: iso(0) },
        { id: 'z', updatedAt: iso(-1_000) },
        { id: 'c', updatedAt: iso(0) },
        { id: 'a', updatedAt: iso(0) },
      ];
      const out = s.advance(c, s.initial(c), page(items));
      expect(out.cursor).toEqual({ value: iso(0), tieBreak: 'c' });
    });

    it('advances only the tie-break when a page continues at the current timestamp', () => {
      const c = cfg({ tieBreak: 'id' });
      const current = cursor(iso(0), 'b');
      const out = s.advance(
        c,
        current,
        page([
          { id: 'a', updatedAt: iso(0) },
          { id: 'd', updatedAt: iso(0) },
        ]),
      );
      expect(out.cursor).toEqual({ value: iso(0), tieBreak: 'd' });
      const smaller = s.advance(c, current, page([{ id: 'a', updatedAt: iso(0) }]));
      expect(smaller.cursor).toEqual({ value: iso(0), tieBreak: 'b' });
    });

    it('keeps tieBreak null when tieBreak is not configured, even on ties', () => {
      const c = cfg();
      const current = cursor(iso(0));
      const out = s.advance(c, current, page([{ id: 'a', updatedAt: iso(0) }]));
      expect(out.cursor).toBe(current);
    });

    it('stringifies numeric tie-break values and ignores missing ones', () => {
      const c = cfg({ tieBreak: 'id' });
      const out = s.advance(
        c,
        s.initial(c),
        page([{ id: 7, updatedAt: iso(0) }, { updatedAt: iso(0) }, { id: 12, updatedAt: iso(0) }]),
      );
      // String comparison: '7' > '12'. Safe (re-fetch, never skip), documented trade-off.
      expect(out.cursor).toEqual({ value: iso(0), tieBreak: '7' });
    });

    it('drops items newer than now - lag and does not advance past them', () => {
      const c = cfg({ lag: '5s' });
      const now = T0 + 10_000;
      const old = { id: 1, updatedAt: '2024-05-01T10:00:00+00:00' };
      const edge = { id: 2, updatedAt: iso(5_000) };
      const fresh = { id: 3, updatedAt: iso(7_000) };
      const out = s.advance(c, s.initial(c), page([fresh, old, edge], { now, hasMore: true }));
      expect(out.items).toEqual([old, edge]);
      expect(out.cursor).toEqual({ value: iso(5_000), tieBreak: null });
      expect(out.done).toBe(false);
    });

    it('keeps the original string of the max kept item when lag filters', () => {
      const c = cfg({ lag: 1_000 });
      const now = T0 + 60_000;
      const out = s.advance(
        c,
        s.initial(c),
        page([{ updatedAt: '2024-05-01T10:00:30+00:00' }, { updatedAt: iso(59_500) }], { now }),
      );
      expect(out.cursor.value).toBe('2024-05-01T10:00:30+00:00');
      expect(out.items).toHaveLength(1);
    });

    it('drops future-dated items when lag is 0', () => {
      const c = cfg();
      const now = T0;
      const out = s.advance(
        c,
        s.initial(c),
        page([{ updatedAt: iso(1) }, { updatedAt: iso(0) }], { now }),
      );
      expect(out.items).toEqual([{ updatedAt: iso(0) }]);
      expect(out.cursor.value).toBe(iso(0));
    });

    it('keeps items with a missing or unparseable field without moving the watermark', () => {
      const c = cfg();
      const current = cursor(iso(0));
      const items = [{ id: 1 }, { id: 2, updatedAt: 'not a date' }, { id: 3, updatedAt: null }];
      const out = s.advance(c, current, page(items));
      expect(out.cursor).toBe(current);
      expect(out.items).toEqual(items);
    });

    it('reads dot paths and accepts numeric epoch and Date fields', () => {
      const c = cfg({ field: 'meta.updatedAt' });
      const epochSeconds = 1714557600 + 30;
      const out = s.advance(c, s.initial(c), page([{ meta: { updatedAt: epochSeconds } }]));
      expect(out.cursor.value).toBe(String(epochSeconds));

      const asDate = s.advance(
        c,
        s.initial(c),
        page([{ meta: { updatedAt: new Date(T0 + 5_000) } }]),
      );
      expect(asDate.cursor.value).toBe(iso(5_000));
    });

    it('uses a string pageCursor as an override and skips lag filtering', () => {
      const c = cfg({ lag: '1h', tieBreak: 'id' });
      const items = [{ id: 'a', updatedAt: iso(0) }];
      const out = s.advance(
        c,
        cursor(iso(-1), 'zzz'),
        page(items, { pageCursor: 'server-says-here', now: T0, hasMore: true }),
      );
      expect(out.cursor).toEqual({ value: 'server-says-here', tieBreak: null });
      expect(out.items).toBe(items);
      expect(out.done).toBe(false);
    });

    it('treats a null pageCursor as no override', () => {
      const c = cfg();
      const out = s.advance(c, s.initial(c), page([{ updatedAt: iso(0) }], { pageCursor: null }));
      expect(out.cursor.value).toBe(iso(0));
    });

    it('uses cfg.parse for both items and the current cursor', () => {
      const c = cfg({ parse: (raw) => Number(raw.slice(1)) });
      const out = s.advance(
        c,
        cursor('v100'),
        page([{ updatedAt: 'v250' }, { updatedAt: 'v90' }], { now: 10_000 }),
      );
      expect(out.cursor.value).toBe('v250');
    });

    it('throws when the persisted cursor value cannot be parsed', () => {
      const c = cfg();
      expect(() => s.advance(c, cursor('garbage'), page([{ updatedAt: iso(0) }]))).toThrow(
        ConfigError,
      );
    });
  });

  describe('forFetch', () => {
    it('is the identity without overlap or with a null value', () => {
      const current = cursor(iso(0), 'a');
      expect(s.forFetch(cfg(), current, T0)).toBe(current);
      const empty = cursor(null);
      expect(s.forFetch(cfg({ overlap: '5m' }), empty, T0)).toBe(empty);
      expect(s.forFetch(cfg({ overlap: 0 }), current, T0)).toBe(current);
    });

    it('moves the value back by overlap and clears the tie-break (ISO)', () => {
      const out = s.forFetch(cfg({ overlap: '5m' }), cursor('2024-05-01T12:00:00+02:00', 'x'), T0);
      expect(out).toEqual({ value: '2024-05-01T09:55:00.000Z', tieBreak: null });
    });

    it('preserves 10-digit and 13-digit epoch formats', () => {
      expect(s.forFetch(cfg({ overlap: '90s' }), cursor('1714557600', 'x'), T0)).toEqual({
        value: '1714557510',
        tieBreak: null,
      });
      expect(s.forFetch(cfg({ overlap: 1_500 }), cursor('1714557600000'), T0)).toEqual({
        value: '1714557598500',
        tieBreak: null,
      });
    });

    it('uses cfg.format when provided', () => {
      const c = cfg({ overlap: 1_000, format: (ms) => `ms:${ms}` });
      expect(s.forFetch(c, cursor(iso(0)), T0)).toEqual({
        value: `ms:${T0 - 1_000}`,
        tieBreak: null,
      });
    });
  });

  it('onCycleComplete is the identity', () => {
    const current = cursor(iso(0), 'a');
    expect(s.onCycleComplete(cfg(), current)).toBe(current);
  });

  it('lagMs reports how far the watermark is behind now', () => {
    const c = cfg();
    expect(s.lagMs(c, cursor(null), T0)).toBeNull();
    expect(s.lagMs(c, cursor(iso(0)), T0 + 42_000)).toBe(42_000);
    expect(s.lagMs(c, cursor('1714557600'), T0 + 1)).toBe(1);
    expect(s.lagMs(c, cursor('garbage'), T0)).toBeNull();
  });

  it('reached compares parsed instants and treats a null target as reached', () => {
    const c = cfg();
    expect(s.reached(c, cursor(null), cursor(null))).toBe(true);
    expect(s.reached(c, cursor(null), cursor(iso(0)))).toBe(false);
    expect(s.reached(c, cursor(iso(0)), cursor('1714557600'))).toBe(true);
    expect(s.reached(c, cursor(iso(1_000)), cursor(iso(0)))).toBe(true);
    expect(s.reached(c, cursor(iso(-1)), cursor(iso(0)))).toBe(false);
  });

  it('fromRaw wraps the raw string with no tie-break', () => {
    expect(s.fromRaw(cfg(), '2024-01-01')).toEqual({ value: '2024-01-01', tieBreak: null });
    expect(s.fromRaw(cfg(), null)).toEqual({ value: null, tieBreak: null });
  });

  it('models a paged catch-up with ties across the page boundary end to end', () => {
    const c = cfg({ tieBreak: 'id', lag: '1s' });
    const now = T0 + 60_000;
    let cur = s.initial(c);
    const p1 = s.advance(
      c,
      cur,
      page(
        [
          { id: 'a', updatedAt: iso(0) },
          { id: 'b', updatedAt: iso(1_000) },
          { id: 'c', updatedAt: iso(1_000) },
        ],
        {
          now,
          hasMore: true,
        },
      ),
    );
    expect(p1.cursor).toEqual({ value: iso(1_000), tieBreak: 'c' });
    expect(p1.done).toBe(false);
    cur = p1.cursor;
    const p2 = s.advance(
      c,
      cur,
      page(
        [
          { id: 'd', updatedAt: iso(1_000) },
          { id: 'e', updatedAt: iso(2_000) },
          { id: 'f', updatedAt: iso(59_500) },
        ],
        {
          now,
          hasMore: false,
        },
      ),
    );
    expect(p2.items.map((i) => (i as { id: string }).id)).toEqual(['d', 'e']);
    expect(p2.cursor).toEqual({ value: iso(2_000), tieBreak: 'e' });
    expect(p2.done).toBe(true);
    expect(s.lagMs(c, p2.cursor, now)).toBe(58_000);
  });
});
