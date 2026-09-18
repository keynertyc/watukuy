import type { CursorConfig } from '../core/cursor-types.ts';

/** What the runner hands to {@link CursorStrategy.advance} after one `fetch` call. */
export interface AdvanceInput {
  /** Validated items of the page. */
  items: unknown[];
  /** `Page.cursor` as returned by `fetch` (token: next cursor; timestamp: watermark override). */
  pageCursor: string | null | undefined;
  /** `Page.hasMore` as returned by `fetch`. */
  hasMore: boolean | undefined;
  /** Current time (epoch ms) from the engine clock. */
  now: number;
}

/** Result of {@link CursorStrategy.advance}. */
export interface AdvanceResult<Cur> {
  /** Next cursor to persist in the same commit as the page's events. */
  cursor: Cur;
  /** `true` when the cycle is complete; `false` makes the runner fetch again immediately. */
  done: boolean;
  /**
   * Items to hand to the change engine. Usually `input.items`; the timestamp strategy drops items
   * newer than `now - lag` (they are re-fetched next cycle).
   */
  items: unknown[];
}

/**
 * One cursor strategy (PLAN §5.2). Pure functions over a config `Cfg` and cursor value `Cur`;
 * nothing here touches the store or the clock, so every rule is unit-testable.
 */
export interface CursorStrategy<Cfg extends CursorConfig, Cur> {
  readonly name: Cfg['strategy'];
  /** Cursor before the first poll. */
  initial(cfg: Cfg): Cur;
  /** Persisted form (JSON text). Must round-trip through {@link deserialize}. */
  serialize(cfg: Cfg, cursor: Cur): string;
  /** Inverse of {@link serialize}. Throws `TypeError` on malformed input. */
  deserialize(cfg: Cfg, raw: string): Cur;
  /**
   * The cursor handed to `fetch()`. Timestamp: the watermark moved back by `overlap` (using
   * `parse`/`format`), with `tieBreak` cleared when overlap applies. Other strategies: identity.
   */
  forFetch(cfg: Cfg, cursor: Cur, now: number): Cur;
  /** Derive the next persisted cursor from one page and decide whether the cycle is done. */
  advance(cfg: Cfg, cursor: Cur, input: AdvanceInput): AdvanceResult<Cur>;
  /** Called when a cycle completes; e.g. `page` resets to its initial page. Default identity. */
  onCycleComplete(cfg: Cfg, cursor: Cur): Cur;
  /** Timestamp only: milliseconds the watermark is behind `now`. Other strategies: `null`. */
  lagMs(cfg: Cfg, cursor: Cur, now: number): number | null;
  /**
   * Has `cursor` reached `target` (backfill lanes)? Timestamp compares parsed times; token, page,
   * snapshotDiff and custom compare serialized forms.
   */
  reached(cfg: Cfg, cursor: Cur, target: Cur): boolean;
  /**
   * Build a cursor from a user-supplied raw string (backfill `from`, `resetCursor({ to })`).
   * `null` means "the beginning" for timestamp/token and "the initial cursor" for page/custom.
   */
  fromRaw(cfg: Cfg, raw: string | null): Cur;
}
