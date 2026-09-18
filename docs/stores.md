# Stores

The `StateStore` is the durability port: leases, cursors, the item snapshot, the outbox, parked events, HTTP validators, and the optional replay log all live there. Four implementations ship in the package; the contract is public so you can write your own.

## Choosing a store

| Store | Import | Peer deps | Use it for | Not for |
|---|---|---|---|---|
| `MemoryStore` | `watukuy` | none | tests, demos, `tick()` prototypes | anything that must survive a restart |
| `SqliteStore` | `watukuy/store-sqlite` | none (`node:sqlite`) | one host: services, sidecars, CLIs, Lambda with EFS; several processes on that host may share the file | processes on different hosts |
| `PostgresStore` | `watukuy/store-postgres` | `pg` (or PGlite) | multi-instance deployments, anything already on Postgres, Cloudflare Workers via Hyperdrive | none in particular |
| `RedisStore` + `RedisBudgetStore` | `watukuy/store-redis` | `redis` or `ioredis` | high-frequency pollers, distributed rate budgets (G6 across instances) | very large snapshots where Redis memory is the constraint |

Default recommendation: **SQLite** for one node, **Postgres** for many. Add **Redis** when you need one rate budget shared across processes. Every store passes the same contract suite, so switching is a one-line change.

```ts
import { createWatukuy, MemoryStore } from 'watukuy';
import { SqliteStore } from 'watukuy/store-sqlite';
import { PostgresStore } from 'watukuy/store-postgres';
import { RedisStore, RedisBudgetStore } from 'watukuy/store-redis';

new MemoryStore();
new SqliteStore({ path: './watukuy.db' });
new PostgresStore({ client: pool });               // pg.Pool or a PGlite instance
new RedisStore({ client: redis });                 // ioredis or node-redis instance, adapted automatically

const engine = createWatukuy({
  store: new PostgresStore({ client: pool }),
  budgetStore: new RedisBudgetStore({ client: redis }), // optional: budgets shared across instances
  pollers: { orders },
});
```

No store constructor performs I/O. Tables are created by `migrate()` or lazily on first use; both are idempotent.

### `MemoryStore`

`new MemoryStore()`. Declares `capabilities: { transactions: true, log: true, streaming: true }`. Everything is `structuredClone`d on the way in and out, so it behaves like a real store, including epoch fencing. State is lost when the process exits. It is the reference implementation of the contract (`src/stores/memory/memory-store.ts`).

### `SqliteStore`

```ts
new SqliteStore({ path: './watukuy.db' });
```

| Option | Default | Meaning |
|---|---|---|
| `path` | required | Database file, or `':memory:'` for a private in-process database that disappears on `close()`. |
| `tablePrefix` | `'watukuy_'` | Prefix applied to every table name. |
| `busyTimeoutMs` | `5000` | How long a statement waits for a lock held by another connection (another process on the same file) before failing with `StoreError`. |

Built on Node's built-in `node:sqlite` (`DatabaseSync`), so there is no native add-on to install. `node:sqlite` is available without a flag from Node 22.13 and 23.4 on and is stable on Node 24; Node 22.12 needs `--experimental-sqlite`. WAL mode plus the lease protocol lets several processes on the same host share one file. `commitPoll` is one transaction; every fenced write checks the lease epoch first and throws `LeaseLostError` on mismatch.

### `PostgresStore`

```ts
import pg from 'pg';
new PostgresStore({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
```

| Option | Default | Meaning |
|---|---|---|
| `client` | required | A `pg.Pool` (or anything with the same `query()` / `connect()` shape) or a PGlite instance. A bare `pg.Client` is not supported. |
| `schema` | `'public'` | Schema that holds the tables; created by `migrate()` when missing. |
| `tablePrefix` | `'watukuy_'` | Prefix applied to every table name. |
| `closeClient` | `false` | Whether `close()` also ends the injected client (`pool.end()` / `pglite.close()`). |

Driver-agnostic; the store detects which client it received and never opens connections. Every fenced write runs in a transaction that locks the poller row and verifies the lease owner and epoch first, so a stale instance can never commit. `migrate()` is safe to run from several instances at once. Works from Cloudflare Workers through Hyperdrive with `nodejs_compat`.

### `RedisStore` and `RedisBudgetStore`

```ts
import { Redis } from 'ioredis';
const client = new Redis(process.env.REDIS_URL!);
new RedisStore({ client });
new RedisBudgetStore({ client });
```

| Option | Default | Meaning |
|---|---|---|
| `client` | required | A connected `ioredis` `Redis` / `Cluster`, a connected node-redis (`redis` v4+) client, or any object implementing the minimal `RedisLike` interface. |
| `prefix` | `'watukuy:'` | Key prefix for everything the store writes. Budget buckets live at `{prefix}budget:{name}`. |

The driver is auto-detected by `adaptRedisClient()`; `fromIoredis()` and `fromNodeRedis()` are exported for explicit use, and `RedisLike` (`eval`, `hgetall`, `hmget`, `hvals`, `hlen`, `hdel`, `hscanFields`, `zcard`, `zrangebyscore`, `zrem`, `smembers`, `srem`, `del`) is the surface a custom adapter must provide. Every fenced write is one Lua `EVAL` that checks `lease_owner` and `lease_epoch` and then performs the multi-key mutation, so `capabilities.transactions` is `true`. Payloads travel as opaque strings; nothing is decoded with `cjson`, so big integers and unicode round-trip byte for byte. The store never opens or closes the connection.

`RedisBudgetStore` implements the `RateBudgetStore` port with a Lua token bucket whose arithmetic mirrors the in-memory bucket exactly, giving G6 across instances. It is driven by the caller's `now` (never Redis `TIME`), so it stays deterministic under a fake clock. Pass it as `budgetStore` to `createWatukuy`.

## Migrations

SQL stores ship idempotent DDL. Apply it once per environment, before the first poll, or let the first store call create the tables lazily:

```ts
await store.migrate();     // or engine.migrate(), which forwards to the store
```

```sh
npx watukuy migrate --store sqlite --path ./watukuy.db
npx watukuy migrate --store postgres --url "$DATABASE_URL"
npx watukuy migrate --config ./watukuy.config.ts       # any store: the module exports the engine
```

Running `migrate()` on an already-migrated database is a no-op. `MemoryStore.migrate()` and `RedisStore.migrate()` resolve immediately. The DDL is also exported (`sqliteMigrations`, `SQLITE_DDL`, `postgresMigrations`, `POSTGRES_TABLES`) for teams that manage schemas with their own migration tool.

## Schema overview

All tables are prefixed `watukuy_` (configurable). The key everywhere is `(poller, partition)`; `partition` is `''` for single-partition pollers. Postgres uses `jsonb` where SQLite uses JSON text.

| Table | Columns | Keys |
|---|---|---|
| `watukuy_pollers` | `poller`, `partition`, `state` (JSON: lane cursors, schedule, circuit, `paused`, `schemaVersion`, last `sequence`), `lease_owner`, `lease_epoch`, `lease_expires_at`, `epoch_counter` | PK `(poller, partition)` |
| `watukuy_items` | `poller`, `partition`, `identity`, `version`, `hash`, `schema_version`, `payload` (nullable; only with `retain: 'payload'`), `seen_at` | PK `(poller, partition, identity)` |
| `watukuy_outbox` | `poller`, `partition`, `seq`, `event_id`, `event` (JSON), `status`, `attempts`, `next_attempt_at`, `last_error` (JSON), `created_at` | PK `(poller, partition, event_id)`; index `(poller, partition, status, seq)` |
| `watukuy_parked` | `poller`, `partition`, `id`, `kind` (`poison` \| `invalid`), `event` (JSON), `item` (JSON), `error` (JSON), `attempts`, `parked_at`, `hold_key` | PK `(poller, partition, id)`; index `(poller, partition, parked_at)` |
| `watukuy_validators` | `poller`, `partition`, `url_hash`, `etag`, `last_modified`, `stored_at` | PK `(poller, partition, url_hash)` |
| `watukuy_log` | `poller`, `partition`, `seq`, `event` (JSON), `created_at` | PK `(poller, partition, seq)`; index `(poller, partition, created_at)` |

Redis layout, per `(poller, partition)`: a meta hash (lease fields), a state hash (one JSON field per top-level `PollerState` field), an items hash, a sorted set for the outbox by `seq` plus hashes for rows, attempts, and errors, a parked hash plus a set of held keys, a validators hash, and a sorted set for the log.

## Sizing

- **Items**: one row per distinct identity per `(poller, partition)`, forever, until the item is deleted upstream and a full-scan lane observes it. Row size with `retain: 'hash'` is identity + version + 64-char hash + a few integers. With `retain: 'payload'` add the JSON payload.
- **Outbox**: transient. Rows are `pending` from commit to ack; a store then deletes them or marks them `delivered`. Only pending rows matter for correctness. A growing pending count means the handler is failing, slow, or absent: check `inspect().pollers[i].outboxPending`.
- **Parked**: grows only when things go wrong. Alert on `parked > 0` and clear it with `retry` / `discard`.
- **Log**: grows with events until pruned by `log.retention`. A poller that emits 10k events a day with `retention: '7d'` keeps roughly 70k rows of `event` JSON.
- **Validators**: one row per distinct URL (including query string) per key. Pollers whose URLs change every cycle (a timestamp in the query) accumulate a row per cycle; prefer stable URLs, or pass `validators: false` to `http.get` for those.
- **Leases**: fields on the poller row; no growth.

A snapshotDiff poller over 1M items in SQLite is a 1M-row `watukuy_items` table (tens of MB with `retain: 'hash'`); `streamIdentities` walks it in batches, so the diff does not load it into memory.

## The `StateStore` contract

```ts
interface StateStore {
  readonly capabilities: { transactions: boolean; log: boolean; streaming: boolean };
  migrate(): Promise<void>;
  close(): Promise<void>;

  // leases (see docs/how-it-works.md)
  acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null>;
  renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean>;
  releaseLease(key: PKey, lease: Lease): Promise<void>;
  getLease(key: PKey): Promise<Lease | null>;

  // state
  loadState(key: PKey): Promise<PollerState | null>;
  saveState(key: PKey, lease: Lease, patch: Partial<Omit<PollerState, 'createdAt'>>): Promise<void>;
  saveStateUnfenced(key: PKey, patch: Partial<Omit<PollerState, 'createdAt'>>): Promise<void>; // pause/resume/reset
  listKeys(poller?: string): Promise<PKey[]>;
  deleteKey(key: PKey): Promise<void>;
  clearItems(key: PKey): Promise<void>;

  // items
  loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>>;
  streamIdentities(key: PKey, batchSize?: number): AsyncIterable<string[]>;
  countItems(key: PKey): Promise<number>;

  // atomic commit + outbox (guarantee G4)
  commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void>;
  loadPending(key: PKey, limit: number): Promise<OutboxRow[]>;   // sequence order, regardless of nextAttemptAt
  countPending(key: PKey): Promise<number>;
  ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void>;
  recordAttempt(key: PKey, lease: Lease, eventId: string, error: SerializedError, nextAttemptAt: number | null): Promise<void>;
  parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void>;
  listParked(key: PKey, opts?: { kind?: 'poison' | 'invalid'; limit?: number }): Promise<ParkedRow[]>;
  countParked(key: PKey): Promise<number>;
  retryParked(key: PKey, ids: string[]): Promise<number>;
  discardParked(key: PKey, ids: string[]): Promise<number>;
  heldKeys(key: PKey): Promise<Set<string>>;

  // http validators
  getValidator(key: PKey, urlHash: string): Promise<Validator | null>;
  setValidator(key: PKey, lease: Lease, urlHash: string, validator: Validator): Promise<void>;

  // event log
  readLog(key: PKey, range: { afterSequence?: number; fromTime?: number; toTime?: number }, limit: number): Promise<LoggedEvent[]>;
  pruneLog(key: PKey, olderThan: number): Promise<number>;
}
```

Rules every implementation must follow:

1. **Fencing.** Every method that takes a `Lease` compares `owner` and `epoch` with the stored lease and rejects with `LeaseLostError` on mismatch. `acquireLease` succeeds only when the key is unowned or the lease has expired (`expiresAt <= now`), and increments the epoch on every acquisition.
2. **Atomicity.** `commitPoll` writes `statePatch`, `upserts`, `deletes`, `events`, the log append (when `batch.log`), and `parked` rows in one transaction, or nothing.
3. **Ordering.** `loadPending` returns rows in `sequence` order and must not filter by `nextAttemptAt`; the dispatcher decides eligibility so per-key order is preserved.
4. **Unfenced administrative writes** (`saveStateUnfenced`, `retryParked`, `discardParked`, `deleteKey`, `clearItems`) exist for `pause`, `resume`, `trigger`, `resetCursor`, and the CLI. They must not touch the lease.
5. **Clones, not references** for in-process stores, so a caller mutating a returned object cannot corrupt state.

## Writing a custom store

Implement the interface above, then certify it with the contract suite:

```ts
import { storeContractSuite } from 'watukuy/testing/store-contract';
import { MyStore } from './my-store.ts';

storeContractSuite({
  name: 'MyStore',
  create: async () => new MyStore(process.env.MY_STORE_URL!),   // fresh, empty store per test; the suite calls migrate()
  destroy: (store) => store.close(),                            // default; drop tables or temp files here if needed
});
```

Call it at the top level of a Vitest file. Every test receives a fresh store from `create()` and tears it down with `destroy()` (default `store.close()`). The suite covers leases (acquire, renew, expire, steal, epoch fencing rejects stale writes), `commitPoll` atomicity and fencing, the outbox and parked lifecycles, validators, `streamIdentities`, and log read and prune (skipped automatically when `capabilities.log` is `false`). It is the same suite the built-in stores run (`src/stores/*/*.test.ts`).

Related: [how-it-works.md](./how-it-works.md), [runbook.md](./runbook.md), [serverless.md](./serverless.md).
