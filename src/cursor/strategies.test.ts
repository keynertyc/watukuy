import { describe, expect, it, vi } from 'vitest';
import type {
  CursorConfig,
  CustomCursorConfig,
  PageCursorConfig,
  SnapshotDiffCursorConfig,
  TokenCursorConfig,
} from '../core/cursor-types.ts';
import { ConfigError } from '../core/errors.ts';
import { customStrategy } from './custom.ts';
import { getStrategy } from './index.ts';
import { pageStrategy } from './page.ts';
import { snapshotDiffStrategy } from './snapshot-diff.ts';
import { tokenStrategy } from './token.ts';
import type { AdvanceInput } from './types.ts';

const NOW = 1_700_000_000_000;
const items = [{ id: 1 }, { id: 2 }];

function page(extra: Partial<AdvanceInput> = {}): AdvanceInput {
  return { items, pageCursor: undefined, hasMore: undefined, now: NOW, ...extra };
}

describe('tokenStrategy', () => {
  const cfg: TokenCursorConfig = { strategy: 'token', initial: null };
  const s = tokenStrategy;

  it('starts from cfg.initial', () => {
    expect(s.name).toBe('token');
    expect(s.initial(cfg)).toEqual({ value: null });
    expect(s.initial({ ...cfg, initial: 'first' })).toEqual({ value: 'first' });
  });

  it('serialize/deserialize round-trip and reject malformed input', () => {
    for (const cur of [{ value: null }, { value: 'abc' }]) {
      const raw = s.serialize(cfg, cur);
      expect(JSON.parse(raw)).toEqual(cur);
      expect(s.deserialize(cfg, raw)).toEqual(cur);
    }
    expect(() => s.deserialize(cfg, '{"value":5}')).toThrow(TypeError);
    expect(() => s.deserialize(cfg, 'nope')).toThrow(TypeError);
    expect(() => s.deserialize(cfg, 'null')).toThrow(TypeError);
  });

  it('continues with the page cursor while the API does not say hasMore: false', () => {
    const out = s.advance(cfg, { value: null }, page({ pageCursor: 'p2' }));
    expect(out).toEqual({ cursor: { value: 'p2' }, done: false, items });
    expect(s.advance(cfg, { value: 'p2' }, page({ pageCursor: 'p3', hasMore: true })).done).toBe(
      false,
    );
  });

  it('supports the sync-token pattern: cursor + hasMore false persists the token and is done', () => {
    const out = s.advance(
      cfg,
      { value: 'old' },
      page({ pageCursor: 'sync-token-2', hasMore: false }),
    );
    expect(out.cursor).toEqual({ value: 'sync-token-2' });
    expect(out.done).toBe(true);
    expect(out.items).toBe(items);
  });

  it('resets to initial and finishes when the page cursor is null, undefined, or empty', () => {
    const withInitial: TokenCursorConfig = { strategy: 'token', initial: 'start' };
    for (const pageCursor of [null, undefined, '']) {
      const out = s.advance(withInitial, { value: 'p9' }, page({ pageCursor, hasMore: true }));
      expect(out).toEqual({ cursor: { value: 'start' }, done: true, items });
    }
    expect(s.advance(cfg, { value: 'p9' }, page({ pageCursor: null })).cursor).toEqual({
      value: null,
    });
  });

  it('identity helpers', () => {
    const cur = { value: 'x' };
    expect(s.forFetch(cfg, cur, NOW)).toBe(cur);
    expect(s.onCycleComplete(cfg, cur)).toBe(cur);
    expect(s.lagMs(cfg, cur, NOW)).toBeNull();
    expect(s.reached(cfg, { value: 'x' }, { value: 'x' })).toBe(true);
    expect(s.reached(cfg, { value: 'x' }, { value: 'y' })).toBe(false);
    expect(s.reached(cfg, { value: null }, { value: null })).toBe(true);
    expect(s.fromRaw(cfg, 'raw')).toEqual({ value: 'raw' });
    expect(s.fromRaw(cfg, null)).toEqual({ value: null });
  });
});

describe('pageStrategy', () => {
  const cfg: PageCursorConfig = { strategy: 'page' };
  const s = pageStrategy;

  it('defaults to page 1 and honours cfg.initial', () => {
    expect(s.name).toBe('page');
    expect(s.initial(cfg)).toEqual({ page: 1 });
    expect(s.initial({ strategy: 'page', initial: 0 })).toEqual({ page: 0 });
  });

  it('serialize/deserialize round-trip and reject malformed input', () => {
    const raw = s.serialize(cfg, { page: 7 });
    expect(JSON.parse(raw)).toEqual({ page: 7 });
    expect(s.deserialize(cfg, raw)).toEqual({ page: 7 });
    expect(() => s.deserialize(cfg, '{"page":"7"}')).toThrow(TypeError);
    expect(() => s.deserialize(cfg, '{"page":1.5}')).toThrow(TypeError);
    expect(() => s.deserialize(cfg, '{"page":-1}')).toThrow(TypeError);
    expect(() => s.deserialize(cfg, '{}')).toThrow(TypeError);
  });

  it('increments while hasMore and finishes otherwise without touching the cursor', () => {
    expect(s.advance(cfg, { page: 1 }, page({ hasMore: true }))).toEqual({
      cursor: { page: 2 },
      done: false,
      items,
    });
    const cur = { page: 4 };
    for (const hasMore of [false, undefined]) {
      const out = s.advance(cfg, cur, page({ hasMore }));
      expect(out.cursor).toBe(cur);
      expect(out.done).toBe(true);
      expect(out.items).toBe(items);
    }
  });

  it('resets to the initial page when a cycle completes', () => {
    expect(s.onCycleComplete(cfg, { page: 9 })).toEqual({ page: 1 });
    expect(s.onCycleComplete({ strategy: 'page', initial: 0 }, { page: 9 })).toEqual({ page: 0 });
  });

  it('walks a multi-page cycle', () => {
    let cur = s.initial(cfg);
    const seen: number[] = [];
    for (const hasMore of [true, true, false]) {
      seen.push(cur.page);
      const out = s.advance(cfg, cur, page({ hasMore }));
      cur = out.cursor;
      if (out.done) cur = s.onCycleComplete(cfg, cur);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(cur).toEqual({ page: 1 });
  });

  it('fromRaw parses page numbers and rejects garbage', () => {
    expect(s.fromRaw(cfg, '12')).toEqual({ page: 12 });
    expect(s.fromRaw(cfg, null)).toEqual({ page: 1 });
    expect(s.fromRaw({ strategy: 'page', initial: 5 }, null)).toEqual({ page: 5 });
    expect(() => s.fromRaw(cfg, 'twelve')).toThrow(TypeError);
    expect(() => s.fromRaw(cfg, '-1')).toThrow(TypeError);
    expect(() => s.fromRaw(cfg, '1.5')).toThrow(TypeError);
  });

  it('identity helpers', () => {
    const cur = { page: 2 };
    expect(s.forFetch(cfg, cur, NOW)).toBe(cur);
    expect(s.lagMs(cfg, cur, NOW)).toBeNull();
    expect(s.reached(cfg, { page: 2 }, { page: 2 })).toBe(true);
    expect(s.reached(cfg, { page: 3 }, { page: 2 })).toBe(false);
  });
});

describe('snapshotDiffStrategy', () => {
  const cfg: SnapshotDiffCursorConfig = { strategy: 'snapshotDiff' };
  const s = snapshotDiffStrategy;

  it('has no cursor at all', () => {
    expect(s.name).toBe('snapshotDiff');
    expect(s.initial(cfg)).toBeNull();
    expect(s.serialize(cfg, null)).toBe('null');
    expect(s.deserialize(cfg, 'null')).toBeNull();
    expect(s.deserialize(cfg, 'anything')).toBeNull();
    expect(s.forFetch(cfg, null, NOW)).toBeNull();
    expect(s.onCycleComplete(cfg, null)).toBeNull();
    expect(s.lagMs(cfg, null, NOW)).toBeNull();
    expect(s.reached(cfg, null, null)).toBe(true);
    expect(s.fromRaw(cfg, 'x')).toBeNull();
    expect(s.fromRaw(cfg, null)).toBeNull();
  });

  it('pages while hasMore is true', () => {
    expect(s.advance(cfg, null, page({ hasMore: true }))).toEqual({
      cursor: null,
      done: false,
      items,
    });
    expect(s.advance(cfg, null, page({ hasMore: false })).done).toBe(true);
    expect(s.advance(cfg, null, page()).done).toBe(true);
  });
});

describe('customStrategy', () => {
  interface Cur {
    offset: number;
  }
  // The engine only ever sees `CustomCursorConfig<unknown>` (via `CursorConfig`), so the
  // strategy is typed against it; user-facing inference happens in `definePoller`.
  type AnyAdvance = CustomCursorConfig<unknown>['advance'];
  const advance = vi.fn<AnyAdvance>((input) => ({
    cursor: { offset: (input.cursor as Cur).offset + input.items.length },
    done: !input.hasMore,
  }));
  const cfg: CustomCursorConfig<unknown> = { strategy: 'custom', initial: { offset: 0 }, advance };
  const s = customStrategy;

  it('starts from cfg.initial', () => {
    expect(s.name).toBe('custom');
    expect(s.initial(cfg)).toEqual({ offset: 0 });
  });

  it('delegates advance with hasMore coerced to a boolean', () => {
    advance.mockClear();
    const out = s.advance(cfg, { offset: 10 }, page({ hasMore: undefined, pageCursor: 'pc' }));
    expect(advance).toHaveBeenCalledWith({
      cursor: { offset: 10 },
      items,
      pageCursor: 'pc',
      hasMore: false,
    });
    expect(out).toEqual({ cursor: { offset: 12 }, done: true, items });
    expect(s.advance(cfg, { offset: 0 }, page({ hasMore: true })).done).toBe(false);
  });

  it('rejects an advance() that does not return { cursor, done }', () => {
    const broken: CustomCursorConfig<unknown> = {
      ...cfg,
      advance: () => ({ cursor: { offset: 1 } }) as unknown as { cursor: unknown; done: boolean },
    };
    expect(() => s.advance(broken, { offset: 0 }, page())).toThrow(ConfigError);
    const nullish: CustomCursorConfig<unknown> = {
      ...cfg,
      advance: () => null as unknown as { cursor: unknown; done: boolean },
    };
    expect(() => s.advance(nullish, { offset: 0 }, page())).toThrow(ConfigError);
  });

  it('defaults to JSON for serialization', () => {
    expect(s.serialize(cfg, { offset: 3 })).toBe('{"offset":3}');
    expect(s.deserialize(cfg, '{"offset":3}')).toEqual({ offset: 3 });
    expect(s.serialize(cfg, undefined)).toBe('null');
    expect(() => s.deserialize(cfg, 'nope')).toThrow(SyntaxError);
  });

  it('uses cfg.serialize / cfg.deserialize when provided', () => {
    const custom: CustomCursorConfig<unknown> = {
      ...cfg,
      serialize: (c) => `off=${(c as Cur).offset}`,
      deserialize: (raw) => ({ offset: Number(raw.slice(4)) }),
    };
    expect(s.serialize(custom, { offset: 8 })).toBe('off=8');
    expect(s.deserialize(custom, 'off=8')).toEqual({ offset: 8 });
    expect(s.fromRaw(custom, 'off=2')).toEqual({ offset: 2 });
    expect(s.reached(custom, { offset: 2 }, { offset: 2 })).toBe(true);
  });

  it('identity helpers and fromRaw(null) → initial', () => {
    const cur = { offset: 1 };
    expect(s.forFetch(cfg, cur, NOW)).toBe(cur);
    expect(s.onCycleComplete(cfg, cur)).toBe(cur);
    expect(s.lagMs(cfg, cur, NOW)).toBeNull();
    expect(s.reached(cfg, { offset: 1 }, { offset: 1 })).toBe(true);
    expect(s.reached(cfg, { offset: 1 }, { offset: 2 })).toBe(false);
    expect(s.fromRaw(cfg, null)).toEqual({ offset: 0 });
    expect(s.fromRaw(cfg, '{"offset":4}')).toEqual({ offset: 4 });
  });
});

describe('getStrategy', () => {
  it('returns the implementation matching cfg.strategy', () => {
    const cases: Array<[CursorConfig, string]> = [
      [{ strategy: 'timestamp', field: 'u', initial: null }, 'timestamp'],
      [{ strategy: 'token', initial: null }, 'token'],
      [{ strategy: 'page' }, 'page'],
      [{ strategy: 'snapshotDiff' }, 'snapshotDiff'],
      [{ strategy: 'custom', initial: 0, advance: () => ({ cursor: 0, done: true }) }, 'custom'],
    ];
    for (const [cfg, name] of cases) {
      const s = getStrategy(cfg);
      expect(s.name).toBe(name);
      expect(s.deserialize(cfg, s.serialize(cfg, s.initial(cfg)))).toEqual(s.initial(cfg));
    }
  });

  it('keeps the cursor type for known configs', () => {
    const s = getStrategy({ strategy: 'page', initial: 3 });
    expect(s.initial({ strategy: 'page', initial: 3 }).page).toBe(3);
  });

  it('throws ConfigError for unknown strategies', () => {
    expect(() => getStrategy({ strategy: 'nope' } as unknown as CursorConfig)).toThrow(ConfigError);
    expect(() => getStrategy({ strategy: 'nope' } as unknown as CursorConfig)).toThrow(/"nope"/);
  });
});
