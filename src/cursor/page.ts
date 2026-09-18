import type { PageCursor, PageCursorConfig } from '../core/cursor-types.ts';
import { isRecord, malformedCursor, parseCursorJson } from './shared.ts';
import type { CursorStrategy } from './types.ts';

function initialPage(cfg: PageCursorConfig): number {
  return cfg.initial ?? 1;
}

function isPageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Page-number APIs (PLAN §5.2). Advances `page + 1` while the page says `hasMore: true`; when a
 * cycle completes the cursor resets to `initial` (default `1`) so the next cycle re-lists from
 * the start. The last fetched page number stays in the record until `onCycleComplete` runs.
 */
export const pageStrategy: CursorStrategy<PageCursorConfig, PageCursor> = {
  name: 'page',

  initial(cfg) {
    return { page: initialPage(cfg) };
  },

  serialize(_cfg, cursor) {
    return JSON.stringify({ page: cursor.page });
  },

  deserialize(_cfg, raw) {
    const parsed = parseCursorJson('page', raw);
    if (!isRecord(parsed) || !isPageNumber(parsed.page)) {
      throw malformedCursor('page', raw, '{ page: non-negative integer }');
    }
    return { page: parsed.page };
  },

  forFetch(_cfg, cursor) {
    return cursor;
  },

  advance(_cfg, cursor, input) {
    if (input.hasMore === true) {
      return { cursor: { page: cursor.page + 1 }, done: false, items: input.items };
    }
    return { cursor, done: true, items: input.items };
  },

  onCycleComplete(cfg) {
    return { page: initialPage(cfg) };
  },

  lagMs() {
    return null;
  },

  reached(_cfg, cursor, target) {
    return cursor.page === target.page;
  },

  fromRaw(cfg, raw) {
    if (raw === null) return { page: initialPage(cfg) };
    const page = Number(raw);
    if (!isPageNumber(page)) {
      throw new TypeError(
        `page cursor: expected a non-negative integer page number, got ${JSON.stringify(raw)}`,
      );
    }
    return { page };
  },
};
