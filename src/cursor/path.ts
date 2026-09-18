/**
 * Read a dot-path (`'meta.updatedAt'`, `'items.0.id'`) from an arbitrary value.
 *
 * Safe on anything: walking through `null`, `undefined`, or a primitive yields `undefined`
 * instead of throwing. Only own and inherited *object* properties are followed; there is no
 * escape syntax, so keys containing `.` cannot be addressed. An empty path returns `obj` itself.
 *
 * @example
 * getPath({ meta: { updatedAt: 't' } }, 'meta.updatedAt'); // 't'
 * getPath(null, 'a.b');                                    // undefined
 */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
