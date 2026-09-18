import type { CustomCursorConfig } from '../core/cursor-types.ts';
import { ConfigError } from '../core/errors.ts';
import type { CursorStrategy } from './types.ts';

function serialize(cfg: CustomCursorConfig<unknown>, cursor: unknown): string {
  if (cfg.serialize) return cfg.serialize(cursor);
  // JSON.stringify(undefined) is undefined, not a string; persist it as JSON null.
  return JSON.stringify(cursor) ?? 'null';
}

function deserialize(cfg: CustomCursorConfig<unknown>, raw: string): unknown {
  return cfg.deserialize ? cfg.deserialize(raw) : JSON.parse(raw);
}

/**
 * User-defined cursor logic (see docs/cursors.md). `advance` delegates to `cfg.advance` with
 * `hasMore` coerced to a boolean; `serialize`/`deserialize` default to JSON. `reached` compares
 * serialized forms; `fromRaw(null)` yields `cfg.initial`. Items are passed through unchanged.
 */
export const customStrategy: CursorStrategy<CustomCursorConfig<unknown>, unknown> = {
  name: 'custom',

  initial(cfg) {
    return cfg.initial;
  },

  serialize,

  deserialize,

  forFetch(_cfg, cursor) {
    return cursor;
  },

  advance(cfg, cursor, input) {
    const next = cfg.advance({
      cursor,
      items: input.items,
      pageCursor: input.pageCursor,
      hasMore: input.hasMore === true,
    });
    if (typeof next !== 'object' || next === null || typeof next.done !== 'boolean') {
      throw new ConfigError(
        'custom cursor: advance() must return { cursor, done: boolean }, got ' +
          (next === null ? 'null' : typeof next),
      );
    }
    return { cursor: next.cursor, done: next.done, items: input.items };
  },

  onCycleComplete(_cfg, cursor) {
    return cursor;
  },

  lagMs() {
    return null;
  },

  reached(cfg, cursor, target) {
    return serialize(cfg, cursor) === serialize(cfg, target);
  },

  fromRaw(cfg, raw) {
    return raw === null ? cfg.initial : deserialize(cfg, raw);
  },
};
