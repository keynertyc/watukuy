/**
 * Parse a persisted cursor and surface a readable `TypeError` when the text is not JSON.
 * @internal
 */
export function parseCursorJson(strategy: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new TypeError(`${strategy} cursor: persisted value is not JSON: ${truncate(raw)}`, {
      cause,
    });
  }
}

/** `true` for non-null, non-array objects. @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `TypeError` for a persisted cursor whose shape does not match the strategy. @internal */
export function malformedCursor(strategy: string, raw: string, expected: string): TypeError {
  return new TypeError(
    `${strategy} cursor: persisted value ${truncate(raw)} does not look like ${expected}`,
  );
}

function truncate(raw: string): string {
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}
