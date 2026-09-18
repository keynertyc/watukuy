import { describe, expect, it } from 'vitest';
import { getPath } from './path.ts';

describe('getPath', () => {
  const obj = {
    a: { b: { c: 42 } },
    arr: [{ id: 'x' }, { id: 'y' }],
    nul: null,
    zero: 0,
    empty: '',
    fn: Object.assign(() => 1, { tag: 'f' }),
  };

  it('reads single and nested keys', () => {
    expect(getPath(obj, 'a')).toBe(obj.a);
    expect(getPath(obj, 'a.b.c')).toBe(42);
    expect(getPath(obj, 'zero')).toBe(0);
    expect(getPath(obj, 'empty')).toBe('');
    expect(getPath(obj, 'nul')).toBeNull();
  });

  it('indexes arrays with numeric segments', () => {
    expect(getPath(obj, 'arr.1.id')).toBe('y');
    expect(getPath(obj, 'arr.length')).toBe(2);
    expect(getPath(obj, 'arr.5.id')).toBeUndefined();
  });

  it('returns undefined for missing keys or when walking through non-objects', () => {
    expect(getPath(obj, 'missing')).toBeUndefined();
    expect(getPath(obj, 'a.missing.c')).toBeUndefined();
    expect(getPath(obj, 'nul.x')).toBeUndefined();
    expect(getPath(obj, 'zero.x')).toBeUndefined();
    expect(getPath(obj, 'a.b.c.d')).toBeUndefined();
  });

  it('is safe on non-object roots', () => {
    expect(getPath(null, 'a')).toBeUndefined();
    expect(getPath(undefined, 'a.b')).toBeUndefined();
    expect(getPath(42, 'toString')).toBeUndefined();
    expect(getPath('str', 'length')).toBeUndefined();
    expect(getPath(true, 'x')).toBeUndefined();
  });

  it('follows function properties', () => {
    expect(getPath(obj, 'fn.tag')).toBe('f');
  });

  it('returns the root for an empty path', () => {
    expect(getPath(obj, '')).toBe(obj);
    expect(getPath(7, '')).toBe(7);
  });

  it('has no escape syntax for dots in keys', () => {
    expect(getPath({ 'a.b': 1 }, 'a.b')).toBeUndefined();
  });
});
