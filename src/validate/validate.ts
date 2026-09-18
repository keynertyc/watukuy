import { ValidationError } from '../core/errors.ts';
import type { StandardSchemaV1 } from '../core/standard-schema.ts';

/** One normalized validation issue: `path` holds plain property keys (no `PathSegment` objects). */
export interface ValidationIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey>;
}

/** An item that failed validation, with the raw item and its normalized issues. */
export interface InvalidItem {
  item: unknown;
  issues: ReadonlyArray<ValidationIssue>;
}

/**
 * Normalize Standard Schema issues: `PathSegment` objects (`{ key }`) collapse to their `key`;
 * issues without a path keep no `path` property at all.
 */
export function normalizeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): ValidationIssue[] {
  return issues.map((issue) => {
    const out: ValidationIssue = { message: issue.message };
    if (issue.path !== undefined) {
      out.path = issue.path.map((segment) =>
        typeof segment === 'object' && segment !== null ? segment.key : segment,
      );
    }
    return out;
  });
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Validate a page of items with a Standard Schema (see docs/delivery.md). Runs before hashing so the
 * change engine sees parsed output (coercions and defaults apply).
 *
 * - `schema` undefined: every item is valid as-is.
 * - Sync and async validators are both supported. A synchronous result is used directly (no
 *   `await`, no microtask), so a page validated by a sync schema completes in one tick.
 * - Relative order is preserved within `valid` and within `invalid`.
 * - Issue paths are normalized with {@link normalizeIssues}.
 */
export async function validateItems(
  schema: StandardSchemaV1 | undefined,
  items: unknown[],
): Promise<{ valid: unknown[]; invalid: InvalidItem[] }> {
  if (schema === undefined) return { valid: [...items], invalid: [] };
  const validate = schema['~standard'].validate;
  const valid: unknown[] = [];
  const invalid: InvalidItem[] = [];
  for (const item of items) {
    const raw = validate(item);
    const result = isPromiseLike(raw) ? await raw : raw;
    if (result.issues === undefined) {
      valid.push(result.value);
    } else {
      invalid.push({ item, issues: normalizeIssues(result.issues) });
    }
  }
  return { valid, invalid };
}

/**
 * Validate one value and return the parsed output, or throw a `ValidationError` carrying the
 * normalized issues.
 */
export async function parseWith<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<T> {
  const raw = schema['~standard'].validate(value);
  const result = isPromiseLike(raw) ? await raw : raw;
  if (result.issues !== undefined) throw new ValidationError(normalizeIssues(result.issues));
  return result.value;
}
