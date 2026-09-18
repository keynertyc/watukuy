import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../core/errors.ts';
import type { StandardSchemaV1 } from '../core/standard-schema.ts';
import { normalizeIssues, parseWith, validateItems } from './validate.ts';

type Result<T> = StandardSchemaV1.Result<T>;

/** Hand-written Standard Schema so these tests stay dependency-free. */
function schema<T>(
  validate: (value: unknown) => Result<T> | Promise<Result<T>>,
): StandardSchemaV1<unknown, T> {
  return { '~standard': { version: 1, vendor: 'watukuy-test', validate } };
}

interface User {
  id: string;
  age: number;
}

/** Sync: requires `{ id: string, age: number-ish }`, coerces `age` to a number, trims `id`. */
const userSchema = schema<User>((value) => {
  if (typeof value !== 'object' || value === null) {
    return { issues: [{ message: 'expected object' }] };
  }
  const v = value as Record<string, unknown>;
  const issues: StandardSchemaV1.Issue[] = [];
  if (typeof v.id !== 'string') issues.push({ message: 'id must be a string', path: ['id'] });
  const age = Number(v.age);
  if (v.age === undefined || Number.isNaN(age)) {
    issues.push({ message: 'age must be numeric', path: [{ key: 'age' }] });
  }
  if (issues.length > 0) return { issues };
  return { value: { id: (v.id as string).trim(), age } };
});

/** Async version of the same schema; resolves on a later microtask. */
const asyncUserSchema = schema<User>(async (value) => {
  await Promise.resolve();
  return userSchema['~standard'].validate(value) as Result<User>;
});

describe('validateItems', () => {
  it('passes everything through untouched when no schema is configured', async () => {
    const items = [{ a: 1 }, 'str', null, undefined];
    const out = await validateItems(undefined, items);
    expect(out.valid).toEqual(items);
    expect(out.valid).not.toBe(items);
    expect(out.invalid).toEqual([]);
  });

  it('splits valid and invalid items, preserving relative order and using parsed output', async () => {
    const ok1 = { id: ' a ', age: '30' };
    const bad1 = { id: 1, age: 'x' };
    const ok2 = { id: 'b', age: 5 };
    const bad2 = 'not an object';
    const out = await validateItems(userSchema, [ok1, bad1, ok2, bad2]);

    expect(out.valid).toEqual([
      { id: 'a', age: 30 },
      { id: 'b', age: 5 },
    ]);
    expect(out.invalid.map((i) => i.item)).toEqual([bad1, bad2]);
    expect(out.invalid[0]?.issues).toEqual([
      { message: 'id must be a string', path: ['id'] },
      { message: 'age must be numeric', path: ['age'] },
    ]);
    expect(out.invalid[1]?.issues).toEqual([{ message: 'expected object' }]);
    // No `path` key at all (not even `path: undefined`) when the validator gave none.
    expect(Object.keys(out.invalid[1]?.issues[0] ?? {})).toEqual(['message']);
  });

  it('supports async validators', async () => {
    const out = await validateItems(asyncUserSchema, [{ id: 'x', age: 1 }, { id: 2 }]);
    expect(out.valid).toEqual([{ id: 'x', age: 1 }]);
    expect(out.invalid).toHaveLength(1);
    expect(out.invalid[0]?.issues.map((i) => i.message)).toEqual([
      'id must be a string',
      'age must be numeric',
    ]);
  });

  it('handles a validator that mixes sync and async results', async () => {
    const mixed = schema<number>((value) =>
      typeof value === 'number'
        ? { value: value * 2 }
        : Promise.resolve({ issues: [{ message: 'nan', path: [] }] }),
    );
    const out = await validateItems(mixed, [1, 'a', 2]);
    expect(out.valid).toEqual([2, 4]);
    expect(out.invalid).toEqual([{ item: 'a', issues: [{ message: 'nan', path: [] }] }]);
  });

  it('does not await synchronous results', async () => {
    const validate = vi.fn((value: unknown): Result<unknown> => ({ value }));
    const sync = schema(validate);
    const promise = validateItems(sync, [1, 2, 3]);
    // Every sync validate call happens before the first macrotask boundary.
    expect(validate).toHaveBeenCalledTimes(3);
    expect((await promise).valid).toEqual([1, 2, 3]);
  });

  it('handles an empty page', async () => {
    expect(await validateItems(userSchema, [])).toEqual({ valid: [], invalid: [] });
  });

  it('calls validate once per item, in order', async () => {
    const validate = vi.fn((value: unknown): Result<unknown> => ({ value }));
    await validateItems(schema(validate), ['a', 'b']);
    expect(validate.mock.calls).toEqual([['a'], ['b']]);
  });
});

describe('normalizeIssues', () => {
  it('collapses PathSegment objects to keys and keeps plain keys', () => {
    const sym = Symbol('s');
    expect(
      normalizeIssues([
        { message: 'm', path: [{ key: 'a' }, 0, 'b', { key: sym }, { key: 2 }] },
        { message: 'no path' },
        { message: 'empty path', path: [] },
      ]),
    ).toEqual([
      { message: 'm', path: ['a', 0, 'b', sym, 2] },
      { message: 'no path' },
      { message: 'empty path', path: [] },
    ]);
  });
});

describe('parseWith', () => {
  it('returns the parsed output', async () => {
    await expect(parseWith(userSchema, { id: ' z ', age: '7' })).resolves.toEqual({
      id: 'z',
      age: 7,
    });
    await expect(parseWith(asyncUserSchema, { id: 'z', age: 7 })).resolves.toEqual({
      id: 'z',
      age: 7,
    });
  });

  it('throws ValidationError with normalized issues', async () => {
    const err = await parseWith(userSchema, { id: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const v = err as ValidationError;
    expect(v.code).toBe('VALIDATION');
    expect(v.issues).toEqual([
      { message: 'id must be a string', path: ['id'] },
      { message: 'age must be numeric', path: ['age'] },
    ]);
    expect(v.message).toContain('id must be a string; age must be numeric');
  });
});
