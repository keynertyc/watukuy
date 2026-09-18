import type { SnapshotDiffCursorConfig } from '../core/cursor-types.ts';
import type { CursorStrategy } from './types.ts';

/**
 * Full-scan APIs with no delta support (PLAN §5.2). There is no cursor (`null`); every cycle
 * re-fetches everything and the change engine diffs it against the stored snapshot, which is how
 * deletes are detected. Pages continue while `hasMore: true`. Any persisted text deserializes to
 * `null`.
 */
export const snapshotDiffStrategy: CursorStrategy<SnapshotDiffCursorConfig, null> = {
  name: 'snapshotDiff',

  initial() {
    return null;
  },

  serialize() {
    return 'null';
  },

  deserialize() {
    return null;
  },

  forFetch() {
    return null;
  },

  advance(_cfg, _cursor, input) {
    return { cursor: null, done: input.hasMore !== true, items: input.items };
  },

  onCycleComplete() {
    return null;
  },

  lagMs() {
    return null;
  },

  reached() {
    return true;
  },

  fromRaw() {
    return null;
  },
};
