import type { CustomCursorConfig } from './cursor-types.ts';

/**
 * Build a `custom` cursor config with full inference: the cursor type is taken from `initial`
 * and flows into `advance()` and into `fetch({ cursor })`.
 *
 * @example
 * const offsets = customCursor({
 *   initial: { offset: 0 },
 *   advance: ({ cursor, items }) => ({
 *     cursor: { offset: cursor.offset + items.length },
 *     done: items.length === 0,
 *   }),
 * });
 * definePoller({ name: 'x', cursor: offsets, fetch: async ({ cursor }) => api.list(cursor.offset), ... });
 */
export function customCursor<C>(
  config: Omit<CustomCursorConfig<C>, 'strategy'>,
): CustomCursorConfig<C> {
  return { strategy: 'custom', ...config };
}
