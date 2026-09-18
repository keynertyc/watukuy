import { StoreError } from '../../core/errors.ts';

/**
 * The narrow Redis surface the store and budget need. Both `ioredis` and `redis` (node-redis)
 * are normalized to this shape by {@link adaptRedisClient}; a custom adapter can implement it
 * directly for any other driver (Valkey, Dragonfly, a mock, ...).
 *
 * Every method returns already-decoded JavaScript values (strings, numbers, arrays, plain
 * objects) and rejects with {@link StoreError} wrapping the driver error.
 */
export interface RedisLike {
  /** `EVAL script numkeys key... arg...`. Lua strings come back as strings, numbers as numbers, tables as arrays, `false` as `null`. */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  hmget(key: string, fields: string[]): Promise<Array<string | null>>;
  hvals(key: string): Promise<string[]>;
  hlen(key: string): Promise<number>;
  hdel(key: string, fields: string[]): Promise<number>;
  /** One `HSCAN` step; only field names are returned (values are dropped). `cursor` is `'0'` when done. */
  hscanFields(
    key: string,
    cursor: string,
    count: number,
  ): Promise<{ cursor: string; fields: string[] }>;
  zcard(key: string): Promise<number>;
  /** `ZRANGEBYSCORE key min max LIMIT offset count`; `min`/`max` accept `-inf`, `+inf` and `(` exclusive bounds. */
  zrangebyscore(
    key: string,
    min: string,
    max: string,
    offset: number,
    count: number,
  ): Promise<string[]>;
  zrem(key: string, members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, members: string[]): Promise<number>;
  del(keys: string[]): Promise<number>;
}

/**
 * Structural subset of an `ioredis` `Redis` / `Cluster` instance. Declared locally so this module
 * has no compile-time dependency on the optional peer; any object with these lowercase methods
 * works.
 */
export interface IoredisLikeClient {
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>;
  hvals(key: string): Promise<string[]>;
  hlen(key: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hscan(
    key: string,
    cursor: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[cursor: string, elements: string[]]>;
  zcard(key: string): Promise<number>;
  zrangebyscore(
    key: string,
    min: string,
    max: string,
    limitToken: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Structural subset of a node-redis (`redis` v4+) client. Declared locally to avoid the deeply
 * generic `RedisClientType`; any connected client (standalone, sentinel, cluster) satisfies it.
 */
export interface NodeRedisLikeClient {
  eval(script: string, options?: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<unknown>;
  hmGet(key: string, fields: string[]): Promise<unknown>;
  hVals(key: string): Promise<unknown>;
  hLen(key: string): Promise<unknown>;
  hDel(key: string, fields: string[]): Promise<unknown>;
  hScan(key: string, cursor: string, options?: { COUNT?: number }): Promise<unknown>;
  zCard(key: string): Promise<unknown>;
  zRangeByScore(
    key: string,
    min: string,
    max: string,
    options?: { LIMIT?: { offset: number; count: number } },
  ): Promise<unknown>;
  zRem(key: string, members: string[]): Promise<unknown>;
  sMembers(key: string): Promise<unknown>;
  sRem(key: string, members: string[]): Promise<unknown>;
  del(keys: string[]): Promise<unknown>;
}

/** Wrap a driver call so failures surface as {@link StoreError} with the driver error as `cause`. */
async function guard<T>(op: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError(`redis ${op} failed: ${describe(err)}`, { cause: err });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toNumber(value: unknown, op: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new StoreError(`redis ${op} returned a non-numeric reply: ${JSON.stringify(value)}`);
}

function toStringArray(value: unknown, op: string): string[] {
  if (Array.isArray(value)) return value.map((v) => toText(v));
  if (value instanceof Set) return Array.from(value, (v) => toText(v));
  throw new StoreError(`redis ${op} returned a non-array reply`);
}

function toNullableStringArray(value: unknown, op: string): Array<string | null> {
  if (Array.isArray(value))
    return value.map((v) => (v === null || v === undefined ? null : toText(v)));
  throw new StoreError(`redis ${op} returned a non-array reply`);
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

/** Accept the three shapes drivers use for hash replies: plain object, `Map`, or flat `[f, v, ...]`. */
function toRecord(value: unknown, op: string): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (value instanceof Map) {
    const out: Record<string, string> = {};
    for (const [k, v] of value) out[toText(k)] = toText(v);
    return out;
  }
  if (Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < value.length; i += 2) out[toText(value[i])] = toText(value[i + 1]);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toText(v);
    return out;
  }
  throw new StoreError(`redis ${op} returned an unexpected reply`);
}

/**
 * Adapt an `ioredis` client (`Redis` or `Cluster`) to {@link RedisLike}.
 *
 * @example
 * import { Redis } from 'ioredis';
 * const store = new RedisStore({ client: fromIoredis(new Redis(url)) });
 */
export function fromIoredis(client: IoredisLikeClient): RedisLike {
  return {
    eval: (script, keys, args) =>
      guard('EVAL', () => client.eval(script, keys.length, ...keys, ...args)),
    hgetall: (key) => guard('HGETALL', async () => toRecord(await client.hgetall(key), 'HGETALL')),
    hmget: (key, fields) =>
      fields.length === 0
        ? Promise.resolve([])
        : guard('HMGET', async () =>
            toNullableStringArray(await client.hmget(key, ...fields), 'HMGET'),
          ),
    hvals: (key) => guard('HVALS', async () => toStringArray(await client.hvals(key), 'HVALS')),
    hlen: (key) => guard('HLEN', async () => toNumber(await client.hlen(key), 'HLEN')),
    hdel: (key, fields) =>
      fields.length === 0
        ? Promise.resolve(0)
        : guard('HDEL', async () => toNumber(await client.hdel(key, ...fields), 'HDEL')),
    hscanFields: (key, cursor, count) =>
      guard('HSCAN', async () => {
        const [next, flat] = await client.hscan(key, cursor, 'COUNT', count);
        const fields: string[] = [];
        for (let i = 0; i < flat.length; i += 2) fields.push(toText(flat[i]));
        return { cursor: toText(next), fields };
      }),
    zcard: (key) => guard('ZCARD', async () => toNumber(await client.zcard(key), 'ZCARD')),
    zrangebyscore: (key, min, max, offset, count) =>
      guard('ZRANGEBYSCORE', async () =>
        toStringArray(
          await client.zrangebyscore(key, min, max, 'LIMIT', offset, count),
          'ZRANGEBYSCORE',
        ),
      ),
    zrem: (key, members) =>
      members.length === 0
        ? Promise.resolve(0)
        : guard('ZREM', async () => toNumber(await client.zrem(key, ...members), 'ZREM')),
    smembers: (key) =>
      guard('SMEMBERS', async () => toStringArray(await client.smembers(key), 'SMEMBERS')),
    srem: (key, members) =>
      members.length === 0
        ? Promise.resolve(0)
        : guard('SREM', async () => toNumber(await client.srem(key, ...members), 'SREM')),
    del: (keys) =>
      keys.length === 0
        ? Promise.resolve(0)
        : guard('DEL', async () => toNumber(await client.del(...keys), 'DEL')),
  };
}

/**
 * Adapt a connected node-redis (`redis` v4+) client to {@link RedisLike}.
 *
 * @example
 * import { createClient } from 'redis';
 * const client = await createClient({ url }).connect();
 * const store = new RedisStore({ client: fromNodeRedis(client) });
 */
export function fromNodeRedis(client: NodeRedisLikeClient): RedisLike {
  return {
    eval: (script, keys, args) =>
      guard('EVAL', () => client.eval(script, { keys, arguments: args })),
    hgetall: (key) => guard('HGETALL', async () => toRecord(await client.hGetAll(key), 'HGETALL')),
    hmget: (key, fields) =>
      fields.length === 0
        ? Promise.resolve([])
        : guard('HMGET', async () =>
            toNullableStringArray(await client.hmGet(key, fields), 'HMGET'),
          ),
    hvals: (key) => guard('HVALS', async () => toStringArray(await client.hVals(key), 'HVALS')),
    hlen: (key) => guard('HLEN', async () => toNumber(await client.hLen(key), 'HLEN')),
    hdel: (key, fields) =>
      fields.length === 0
        ? Promise.resolve(0)
        : guard('HDEL', async () => toNumber(await client.hDel(key, fields), 'HDEL')),
    hscanFields: (key, cursor, count) =>
      guard('HSCAN', async () => {
        const reply = (await client.hScan(key, cursor, { COUNT: count })) as {
          cursor: unknown;
          entries: unknown;
        };
        const fields: string[] = [];
        if (Array.isArray(reply.entries)) {
          for (const entry of reply.entries as Array<{ field: unknown }>) {
            fields.push(toText(entry.field));
          }
        }
        return { cursor: toText(reply.cursor), fields };
      }),
    zcard: (key) => guard('ZCARD', async () => toNumber(await client.zCard(key), 'ZCARD')),
    zrangebyscore: (key, min, max, offset, count) =>
      guard('ZRANGEBYSCORE', async () =>
        toStringArray(
          await client.zRangeByScore(key, min, max, { LIMIT: { offset, count } }),
          'ZRANGEBYSCORE',
        ),
      ),
    zrem: (key, members) =>
      members.length === 0
        ? Promise.resolve(0)
        : guard('ZREM', async () => toNumber(await client.zRem(key, members), 'ZREM')),
    smembers: (key) =>
      guard('SMEMBERS', async () => toStringArray(await client.sMembers(key), 'SMEMBERS')),
    srem: (key, members) =>
      members.length === 0
        ? Promise.resolve(0)
        : guard('SREM', async () => toNumber(await client.sRem(key, members), 'SREM')),
    del: (keys) =>
      keys.length === 0
        ? Promise.resolve(0)
        : guard('DEL', async () => toNumber(await client.del(keys), 'DEL')),
  };
}

function hasMethod<K extends string>(
  value: object,
  name: K,
): value is Record<K, (...a: never[]) => unknown> {
  return typeof (value as Record<string, unknown>)[name] === 'function';
}

/**
 * Auto-detect the driver behind `client` and wrap it as {@link RedisLike}:
 *
 * - node-redis (`redis`): detected by the camelCase `hGet` method;
 * - ioredis: detected by the lowercase `hgetall` method;
 * - an object that already implements {@link RedisLike} (has `hscanFields`) is returned as is.
 *
 * @throws {StoreError} when the object matches none of the above.
 */
export function adaptRedisClient(client: unknown): RedisLike {
  if (client !== null && typeof client === 'object') {
    if (hasMethod(client, 'hscanFields') && hasMethod(client, 'eval')) {
      return client as unknown as RedisLike;
    }
    if (hasMethod(client, 'hGet') && hasMethod(client, 'eval')) {
      return fromNodeRedis(client as unknown as NodeRedisLikeClient);
    }
    if (hasMethod(client, 'hgetall') && hasMethod(client, 'eval')) {
      return fromIoredis(client as unknown as IoredisLikeClient);
    }
  }
  throw new StoreError(
    'RedisStore: unsupported client. Pass a connected ioredis instance (`new Redis(url)`), a ' +
      'connected node-redis client (`await createClient({ url }).connect()`), or an object ' +
      'implementing RedisLike (see fromIoredis / fromNodeRedis).',
  );
}
