import type { Duration } from './duration.ts';

/**
 * `updated_since`-style APIs. The cursor is a composite keyset `(value, tieBreak)` so items that
 * share one timestamp across a page boundary are never skipped (see docs/cursors.md).
 */
export interface TimestampCursorConfig {
  strategy: 'timestamp';
  /** Item field holding the timestamp. Dot paths allowed (`'meta.updatedAt'`). */
  field: string;
  /**
   * Item field used to break ties when several items share the cursor timestamp. Set to `null`
   * when the API cannot page past an id; then rely on `overlap`.
   * @default null
   */
  tieBreak?: string | null | undefined;
  /** Initial cursor value (the API's own string format). `null` starts from the beginning. */
  initial: string | null;
  /**
   * Never read past `now - lag`. Protects against rows committed late with an earlier timestamp.
   * @default 0
   */
  lag?: Duration | undefined;
  /**
   * Re-scan `[cursor - overlap, cursor]` every cycle. Re-seen items are suppressed by the
   * identity→version map, so this costs requests, never duplicate events.
   * @default 0
   */
  overlap?: Duration | undefined;
  /**
   * Parse the API's timestamp string to epoch milliseconds. Defaults to `Date.parse`, with
   * automatic handling of all-digit epoch seconds (10 digits) and milliseconds (13 digits).
   */
  parse?: ((raw: string) => number) | undefined;
  /**
   * Format epoch milliseconds back into the API's string form. Only used for `overlap`
   * arithmetic; the persisted cursor is always the server's own string.
   * Defaults to ISO 8601, or the same digit form the API used.
   */
  format?: ((epochMs: number, sample: string | null) => string) | undefined;
}

/** Runtime cursor of the `timestamp` strategy: the watermark plus the tie-break value. */
export interface TimestampCursor {
  /** The API's own string for the watermark; never re-serialized from a Date. */
  value: string | null;
  /** Last seen tie-break value at `value`, when `tieBreak` is configured. */
  tieBreak: string | null;
}

/** Opaque `next` cursor APIs. A `null` cursor returned by `fetch` means caught up. */
export interface TokenCursorConfig {
  strategy: 'token';
  initial: string | null;
}

/** Runtime cursor of the `token` strategy. */
export interface TokenCursor {
  value: string | null;
}

/** Page-number APIs. Advances while `hasMore`; resets to `initial` when a cycle completes. */
export interface PageCursorConfig {
  strategy: 'page';
  /** @default 1 */
  initial?: number | undefined;
}

/** Runtime cursor of the `page` strategy (1-based unless `initial` says otherwise). */
export interface PageCursor {
  page: number;
}

/**
 * APIs with no delta support at all: the full response is fetched each cycle, hashed per item,
 * and diffed against the stored snapshot. The only strategy that detects deletes by itself.
 */
export interface SnapshotDiffCursorConfig {
  strategy: 'snapshotDiff';
}

/** User-defined cursor logic for anything else. */
export interface CustomCursorConfig<C = unknown> {
  strategy: 'custom';
  initial: C;
  /** Derive the next cursor from a fetched page. `done: true` ends the cycle. */
  advance(input: {
    cursor: C;
    items: unknown[];
    pageCursor: string | null | undefined;
    hasMore: boolean;
  }): { cursor: C; done: boolean };
  serialize?(cursor: C): string;
  deserialize?(raw: string): C;
}

/** Union of every cursor strategy configuration accepted by `definePoller`. */
export type CursorConfig =
  | TimestampCursorConfig
  | TokenCursorConfig
  | PageCursorConfig
  | SnapshotDiffCursorConfig
  | CustomCursorConfig<unknown>;

/** The `strategy` discriminator of a `CursorConfig`. */
export type CursorStrategyName = CursorConfig['strategy'];

/** The runtime cursor value seen by `fetch`, derived from the strategy. */
export type CursorValue<C extends CursorConfig> = C extends TimestampCursorConfig
  ? TimestampCursor
  : C extends TokenCursorConfig
    ? TokenCursor
    : C extends PageCursorConfig
      ? PageCursor
      : C extends SnapshotDiffCursorConfig
        ? null
        : C extends CustomCursorConfig<infer X>
          ? X
          : never;
