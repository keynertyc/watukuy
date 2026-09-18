/**
 * Cursor strategies (PLAN §5.2): timestamp, token, page, snapshotDiff, custom.
 * @module
 */

import type {
  CursorConfig,
  CustomCursorConfig,
  PageCursor,
  PageCursorConfig,
  SnapshotDiffCursorConfig,
  TimestampCursor,
  TimestampCursorConfig,
  TokenCursor,
  TokenCursorConfig,
} from '../core/cursor-types.ts';
import { ConfigError } from '../core/errors.ts';
import { customStrategy } from './custom.ts';
import { pageStrategy } from './page.ts';
import { snapshotDiffStrategy } from './snapshot-diff.ts';
import { timestampStrategy } from './timestamp.ts';
import { tokenStrategy } from './token.ts';
import type { CursorStrategy } from './types.ts';

export { customStrategy } from './custom.ts';
export { pageStrategy } from './page.ts';
export { getPath } from './path.ts';
export { snapshotDiffStrategy } from './snapshot-diff.ts';
export {
  compareTimestamps,
  formatTimestamp,
  parseTimestamp,
  timestampStrategy,
} from './timestamp.ts';
export { tokenStrategy } from './token.ts';
export type { AdvanceInput, AdvanceResult, CursorStrategy } from './types.ts';

/**
 * Resolve the strategy implementation for a cursor config. Overloads keep the cursor type when
 * the config type is known; the `CursorConfig` overload is what the runner uses.
 *
 * @throws {ConfigError} for an unknown `strategy`.
 */
export function getStrategy(
  cfg: TimestampCursorConfig,
): CursorStrategy<TimestampCursorConfig, TimestampCursor>;
export function getStrategy(cfg: TokenCursorConfig): CursorStrategy<TokenCursorConfig, TokenCursor>;
export function getStrategy(cfg: PageCursorConfig): CursorStrategy<PageCursorConfig, PageCursor>;
export function getStrategy(
  cfg: SnapshotDiffCursorConfig,
): CursorStrategy<SnapshotDiffCursorConfig, null>;
export function getStrategy(
  cfg: CustomCursorConfig<unknown>,
): CursorStrategy<CustomCursorConfig<unknown>, unknown>;
export function getStrategy(cfg: CursorConfig): CursorStrategy<CursorConfig, unknown>;
export function getStrategy(cfg: CursorConfig): CursorStrategy<CursorConfig, unknown> {
  switch (cfg.strategy) {
    case 'timestamp':
      return timestampStrategy;
    case 'token':
      return tokenStrategy;
    case 'page':
      return pageStrategy;
    case 'snapshotDiff':
      return snapshotDiffStrategy;
    case 'custom':
      return customStrategy;
    default:
      throw new ConfigError(
        `unknown cursor strategy ${JSON.stringify((cfg as { strategy?: unknown }).strategy)}`,
      );
  }
}
