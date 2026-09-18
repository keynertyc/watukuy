/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Produces one and only one JSON text for a given value so that hashes never differ because of
 * key order, whitespace, or number formatting (PLAN §5.3). Rules implemented:
 *
 * - Object keys are sorted by UTF-16 code units; whitespace is never emitted.
 * - Numbers use ES `Number.prototype.toString` semantics (`1e21` → `1e+21`, `1.0` → `1`,
 *   `-0` → `0`, `0.000001` stays decimal, `1e-7` uses the exponent form).
 * - Strings are escaped like `JSON.stringify` (`"`, `\`, and control characters below 0x20 with
 *   the short forms `\b \t \n \f \r` and lowercase `\u00xx` otherwise), which is what JCS §3.2.2.2
 *   prescribes.
 * - Values with a `toJSON()` method (e.g. `Date`) are replaced by its result first.
 * - Boxed primitives (`new Number(1)`) are unwrapped like `JSON.stringify` does.
 * - `undefined`, functions, and symbols are omitted inside objects and become `null` inside arrays
 *   or at the top level (again mirroring `JSON.stringify`, except at the top level where
 *   `JSON.stringify` would return `undefined`).
 *
 * Values JCS cannot represent throw a `TypeError` instead of silently degrading: `NaN`,
 * `±Infinity`, `BigInt`, `Map`, `Set`, and circular structures.
 *
 * @example
 * canonicalize({ b: 2, a: [1, 1.0, -0] }); // '{"a":[1,1,0],"b":2}'
 *
 * @throws {TypeError} for non-finite numbers, BigInt, Map, Set, or cycles.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}

/** Compare two strings by UTF-16 code units, the order JCS mandates for object keys. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return serializeNumber(value);
    case 'bigint':
      throw new TypeError(
        'canonicalize: BigInt values are not representable in JSON; convert them to a string or number in fingerprint()',
      );
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalize: unsupported value of type ${typeof value}`);
  }
  if (value === null) return 'null';
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return serialize((value as { toJSON: () => unknown }).toJSON(), ancestors);
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return serialize(value.valueOf(), ancestors);
  }
  if (value instanceof Map || value instanceof Set) {
    const kind = value instanceof Map ? 'Map' : 'Set';
    throw new TypeError(
      `canonicalize: ${kind} has no JSON representation; convert it in fingerprint() (e.g. Object.fromEntries(map) or [...set])`,
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError('canonicalize: circular structure cannot be canonicalized');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, ancestors);
    return serializeObject(value as Record<string, unknown>, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`canonicalize: ${String(value)} is not representable in JSON`);
  }
  // `String(-0)` is already '0', but be explicit: JCS forbids a negative zero literal.
  if (value === 0) return '0';
  return String(value);
}

function serializeArray(value: unknown[], ancestors: Set<object>): string {
  let out = '[';
  for (let i = 0; i < value.length; i++) {
    if (i > 0) out += ',';
    out += serialize(value[i], ancestors);
  }
  return `${out}]`;
}

function serializeObject(value: Record<string, unknown>, ancestors: Set<object>): string {
  const keys = Object.keys(value).sort(compareCodeUnits);
  let out = '{';
  let first = true;
  for (const key of keys) {
    const member = value[key];
    const kind = typeof member;
    if (kind === 'undefined' || kind === 'function' || kind === 'symbol') continue;
    if (!first) out += ',';
    first = false;
    out += `${JSON.stringify(key)}:${serialize(member, ancestors)}`;
  }
  return `${out}}`;
}
