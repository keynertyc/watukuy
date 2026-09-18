import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonicalize.ts';

/** Control characters built at runtime so the formatter cannot inline them into the source. */
const ch = (code: number): string => String.fromCharCode(code);
const SHIFT_IN = ch(0x0f);
const C80 = ch(0x80);

describe('canonicalize (RFC 8785)', () => {
  it('reproduces the RFC 8785 §3.2.3 sample', () => {
    const input = {
      // The RFC writes the first number as 333333333.33333329; it denotes the same IEEE 754 double.
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: `€$${SHIFT_IN}\nA'B"\\\\"/`,
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts object keys by UTF-16 code units (RFC 8785 §3.2.3 ordering sample)', () => {
    // Keys are built from code points so that editors/formatters cannot NFC-normalize them
    // (U+FB33 would otherwise decompose into U+05D3 U+05BC and sort differently).
    const euro = ch(0x20ac);
    const dalet = ch(0xfb33);
    const grin = String.fromCodePoint(0x1f600);
    const oUmlaut = ch(0xf6);
    const input: Record<string, string> = {
      [euro]: 'Euro Sign',
      '\r': 'Carriage Return',
      [dalet]: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      [grin]: 'Emoji: Grinning Face',
      [C80]: 'Control',
      [oUmlaut]: 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalize(input)).toBe(
      `{"\\r":"Carriage Return","1":"One","${C80}":"Control","${oUmlaut}":"Latin Small Letter O With Diaeresis","${euro}":"Euro Sign","${grin}":"Emoji: Grinning Face","${dalet}":"Hebrew Letter Dalet With Dagesh"}`,
    );
    // Sanity: the surrogate pair (0xD83D) sorts before U+FB33 even though its code point is larger.
    expect(grin.charCodeAt(0)).toBeLessThan(dalet.charCodeAt(0));
    expect(grin.codePointAt(0)).toBeGreaterThan(dalet.codePointAt(0) as number);
  });

  it('is independent of key insertion order, at every nesting level', () => {
    const a = { z: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' }, m: null };
    const b = { m: null, a: { c: 'x', d: [1, { x: 1, y: 2 }] }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"m":null,"z":1}');
  });

  it('emits no whitespace', () => {
    expect(canonicalize({ a: [1, 2, { b: 'c d' }] })).toBe('{"a":[1,2,{"b":"c d"}]}');
  });

  it.each<[number, string]>([
    [1e21, '1e+21'],
    [1e20, '100000000000000000000'],
    [0.000001, '0.000001'],
    [1e-7, '1e-7'],
    [1.0, '1'],
    [-0, '0'],
    [0, '0'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [9007199254740992, '9007199254740992'],
    [0.1 + 0.2, '0.30000000000000004'],
    [-1.5, '-1.5'],
    [100, '100'],
  ])('serializes number %s as %s', (value, expected) => {
    expect(canonicalize(value)).toBe(expected);
  });

  it('treats 1E+21, 1e21 and 1000000000000000000000 identically', () => {
    expect(canonicalize(Number('1E+21'))).toBe('1e+21');
    expect(canonicalize(Number('1000000000000000000000'))).toBe('1e+21');
    expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize({ a: [Number.NEGATIVE_INFINITY] })).toThrow(TypeError);
  });

  it('rejects BigInt with a helpful message', () => {
    expect(() => canonicalize(10n)).toThrow(/BigInt/);
    expect(() => canonicalize({ id: 10n })).toThrow(/fingerprint\(\)/);
  });

  it('rejects Map and Set with a helpful message', () => {
    expect(() => canonicalize(new Map([['a', 1]]))).toThrow(/Map has no JSON representation/);
    expect(() => canonicalize({ tags: new Set(['a']) })).toThrow(/Set has no JSON representation/);
  });

  it('rejects circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => canonicalize(a)).toThrow(/circular/);
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalize({ arr })).toThrow(/circular/);
  });

  it('does not treat a shared (non-circular) reference as a cycle', () => {
    const shared = { k: 1 };
    expect(canonicalize({ a: shared, b: shared, c: [shared, shared] })).toBe(
      '{"a":{"k":1},"b":{"k":1},"c":[{"k":1},{"k":1}]}',
    );
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalize(`a"b\\c${ch(0x01)}${ch(0x1f)}\t\n`)).toBe(
      '"a\\"b\\\\c\\u0001\\u001f\\t\\n"',
    );
    expect(canonicalize(`${ch(0x08)}${ch(0x0c)}\r`)).toBe('"\\b\\f\\r"');
    const loneSurrogate = ch(0xd800);
    expect(canonicalize(loneSurrogate)).toBe(JSON.stringify(loneSurrogate));
    expect(canonicalize('ünïcödé 😀')).toBe('"ünïcödé 😀"');
  });

  it('preserves array order and turns holes/undefined into null', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([undefined, () => 1, Symbol('s')])).toBe('[null,null,null]');
    const holes: unknown[] = [1];
    holes[2] = 3;
    expect(canonicalize(holes)).toBe('[1,null,3]');
    expect(canonicalize([])).toBe('[]');
  });

  it('omits undefined, function, and symbol members of objects', () => {
    expect(canonicalize({ a: undefined, b: () => 1, c: Symbol('x'), d: 1 })).toBe('{"d":1}');
    expect(canonicalize({})).toBe('{}');
  });

  it('serializes undefined, functions, and symbols at the top level as null', () => {
    expect(canonicalize(undefined)).toBe('null');
    expect(canonicalize(() => 1)).toBe('null');
    expect(canonicalize(Symbol('s'))).toBe('null');
  });

  it('serializes primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize('')).toBe('""');
  });

  it('uses toJSON when present (Date → ISO string)', () => {
    const at = new Date('2025-01-02T03:04:05.006Z');
    expect(canonicalize(at)).toBe('"2025-01-02T03:04:05.006Z"');
    expect(canonicalize({ at })).toBe('{"at":"2025-01-02T03:04:05.006Z"}');
    expect(canonicalize({ toJSON: () => ({ b: 1, a: 2 }) })).toBe('{"a":2,"b":1}');
  });

  it('unwraps boxed primitives', () => {
    expect(canonicalize(new Number(1.0))).toBe('1');
    expect(canonicalize(new String('s'))).toBe('"s"');
    expect(canonicalize(new Boolean(false))).toBe('false');
  });

  it('only serializes own enumerable string keys', () => {
    const proto = { inherited: 1 };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj.own = 2;
    Object.defineProperty(obj, 'hidden', { value: 3, enumerable: false });
    const sym = Symbol('s');
    obj[sym as unknown as string] = 4;
    expect(canonicalize(obj)).toBe('{"own":2}');
  });

  it('produces valid JSON that round-trips', () => {
    const input = { z: [1, 'two', { three: 3.5, four: null }], a: 'b\n"c"', n: -0 };
    const out = canonicalize(input);
    expect(JSON.parse(out)).toEqual({ ...input, n: 0 });
  });
});
