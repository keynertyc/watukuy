import type { TokenCursor, TokenCursorConfig } from '../core/cursor-types.ts';
import { isRecord, malformedCursor, parseCursorJson } from './shared.ts';
import type { CursorStrategy } from './types.ts';

/**
 * Opaque `next`-cursor APIs (PLAN §5.2).
 *
 * - A non-empty string `Page.cursor` becomes the next cursor. The cycle continues unless the
 *   page says `hasMore: false` — the "sync token" pattern, where the API hands back a token to
 *   use *next time* together with "nothing more right now".
 * - A `null`/`undefined`/empty `Page.cursor` means the listing is exhausted: the cycle is done
 *   and the cursor resets to `initial` so the next cycle starts over.
 * - Items are passed through unchanged; deletes need the `reconcile` lane.
 */
export const tokenStrategy: CursorStrategy<TokenCursorConfig, TokenCursor> = {
  name: 'token',

  initial(cfg) {
    return { value: cfg.initial };
  },

  serialize(_cfg, cursor) {
    return JSON.stringify({ value: cursor.value });
  },

  deserialize(_cfg, raw) {
    const parsed = parseCursorJson('token', raw);
    if (!isRecord(parsed) || !(typeof parsed.value === 'string' || parsed.value === null)) {
      throw malformedCursor('token', raw, '{ value: string | null }');
    }
    return { value: parsed.value };
  },

  forFetch(_cfg, cursor) {
    return cursor;
  },

  advance(cfg, _cursor, input) {
    if (typeof input.pageCursor === 'string' && input.pageCursor !== '') {
      return {
        cursor: { value: input.pageCursor },
        done: input.hasMore === false,
        items: input.items,
      };
    }
    return { cursor: { value: cfg.initial }, done: true, items: input.items };
  },

  onCycleComplete(_cfg, cursor) {
    return cursor;
  },

  lagMs() {
    return null;
  },

  reached(_cfg, cursor, target) {
    return cursor.value === target.value;
  },

  fromRaw(_cfg, raw) {
    return { value: raw };
  },
};
