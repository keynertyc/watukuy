# API reference (compact)

Every export of `watukuy` and its subpaths, grouped by concern, one line each. Full signatures, JSDoc, and examples are in the generated TypeDoc (`pnpm docs:api`) and in the `.d.ts` files shipped with the package.

## `watukuy`

### Factories

| Export | Description |
|---|---|
| `definePoller(config)` | Declare a poller: how to fetch and how to identify items. Validates eagerly, applies defaults, infers the item type from `schema` or from the `identity` parameter. Returns an opaque `PollerDefinition`. |
| `createWatukuy(options)` | Create the engine from a `store`, a keyed `pollers` object (key must equal the poller `name`), optional `budgets`, `budgetStore`, `instanceId`, `clock`, `random`, `logger`, `hooks`, `lease: { ttl, renewEvery }`, `sourcePrefix`, `fetch`, `dispatchBatchSize`. |
| `customCursor({ initial, advance, serialize?, deserialize? })` | Build a `custom` cursor config with the cursor type inferred from `initial`. |
| `isPollerDefinition(value)` | Type guard for `definePoller` results. |
| `toCloudEvent(event)` | Convert a `WatukuyEvent` to a CloudEvents 1.0 structured-mode object: `type` becomes `<poller>.<created\|updated\|deleted>`; extensions `watukuypartition`, `watukuylane`, `watukuysequence`, `watukuypoller`, and `watukuyprevious` when `previous` is set. |
| `MemoryStore` | In-memory `StateStore`; reference implementation, for tests and prototypes. |
| `emptyPollerState(now)` | The zero `PollerState`; useful when writing a store. |

### `definePoller` options

| Option | Type | Default |
|---|---|---|
| `name` | `string` matching `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$` | required |
| `schema` | Standard Schema v1 | none |
| `identity` | `(item) => string` | required |
| `version` | `(item) => string \| number` | content hash |
| `fingerprint` | `(item) => unknown` | whole item |
| `schemaVersion` | integer >= 1 | `1` |
| `cursor` | `TimestampCursorConfig \| TokenCursorConfig \| PageCursorConfig \| SnapshotDiffCursorConfig \| CustomCursorConfig` | required |
| `fetch` | `(ctx) => Promise<Page> \| AsyncIterable<Page>` | required |
| `schedule` | `{ min, max, adaptive?, jitter?, backoff? }` | `{ min: '30s', max: '5m', adaptive: true, jitter: 0.1, backoff: { base: '1s', factor: 2, max: '10m' } }` |
| `budget` | `string` (a key of `createWatukuy({ budgets })`) | none |
| `budgetWeight` | `number > 0` | `1` |
| `budgetCost` | `number >= 0` per HTTP call | `1` |
| `partitions` | `() => Partition[] \| Promise<Partition[]>` | one partition `''` |
| `partitionsRefresh` | `Duration` | `'5m'` |
| `delivery` | `{ orderingKey?, concurrency?, retry?, poison?, ackMode? }` | `{ orderingKey: e => e.subject, concurrency: 1, retry: { attempts: 5, backoff: { base: '1s', factor: 2, max: '2m' } }, poison: { action: 'park', holdKey: true }, ackMode: 'auto' }` |
| `retain` | `'hash' \| 'payload'` | `'hash'` |
| `reconcile` | `{ every, fetch }` | none; rejected for `snapshotDiff` |
| `onInvalid` | `'quarantine' \| 'skip' \| 'fail'` | `'quarantine'` |
| `onSchemaChange` | `'rebaseline' \| 'emit'` | `'rebaseline'` |
| `maxPagesPerCycle` | integer >= 1 | `50` |
| `circuit` | `{ failures?, probeEvery? }` | `{ failures: 5, probeEvery: schedule.max }` |
| `log` | `{ retention }` | none (enables `replay()`) |
| `source` | `string` | `urn:watukuy:<name>` |

### Engine

| Member | Description |
|---|---|
| `status` | `'idle' \| 'running' \| 'stopping' \| 'stopped'`. |
| `instanceId` | This process's id in leases and `inspect()`. |
| `on(name, handler)` | Register the handler `(event, ctx) => void \| Promise<void>`; returns an unsubscribe function. One consumer per poller. |
| `subscribe(name, { signal? })` | Backpressured `AsyncIterable<WatukuyEvent>`; acks on the next pull. Mutually exclusive with `on()`. |
| `start()` | Daemon mode. |
| `stop({ drain?: true, timeout?: '30s' })` | Graceful stop; aborts what is left after `timeout`. |
| `tick({ maxDuration?, only? })` | One pass over due keys; returns `TickResult`. |
| `trigger(name, { partition? })` | Mark due now; clears the throttle window. |
| `pause(name, { partition? })` / `resume(...)` | Skip / unskip a key. |
| `backfill(name, { from, to?, partition?, force? })` | Start a backfill lane from a raw cursor. |
| `replay(name, { from, to?, partition? })` | Re-emit logged events; returns `{ replayed }`. Needs `log`. |
| `resetCursor(name, { to, partition?, clearSnapshot? })` | Rewind the live lane; optionally drop the snapshot. |
| `parked.list(name, { partition?, kind?, limit? })` | Parked poison events and quarantined items. |
| `parked.retry(name, ids, { partition? })` | Back to the outbox; returns the count. |
| `parked.discard(name, ids, { partition? })` | Drop; returns the count. |
| `partitions.list(name)` | Force a refresh and return the partitions. |
| `partitions.remove(name, partition)` | Delete every row for the key. |
| `inspect()` | `InspectReport` with one `PollerInspect` per active key. |
| `migrate()` | Forward to `store.migrate()`. |

### Event envelope

```ts
interface WatukuyEvent<Item> {
  id: string;            // sha256 hex of 'watukuy|v1|source|partition|identity|version-or-hash|schemaVersion|type'
  type: 'created' | 'updated' | 'deleted';
  source: string;        // 'urn:watukuy:<poller>' unless overridden
  subject: string;       // the identity
  time: string;          // ISO 8601 observation time
  poller: string;
  partition: string;     // '' for single-partition pollers
  lane: 'live' | 'backfill' | 'reconcile' | 'replay';
  sequence: number;      // monotonic per (poller, partition)
  cursor: unknown;       // reserved; populated for deleted events from full scans, null otherwise in this release
  data: Item | undefined;      // undefined for deleted with retain: 'hash'
  previous?: Item;             // with retain: 'payload'
  attempt: number;             // 1-based delivery attempt
}

interface HandlerContext { signal: AbortSignal; logger: Logger; partition: Partition; attempt: number; ack(): void }
```

### Errors

All extend `WatukuyError` with a stable `code`.

| Class | `code` | When |
|---|---|---|
| `ConfigError` | `CONFIG` | invalid poller or engine configuration; thrown eagerly |
| `LeaseLostError` | `LEASE_LOST` | a fenced write hit a newer epoch; carries `poller`, `partition`, `epoch` |
| `HttpError` | `HTTP` | non-2xx from `ctx.http`; `status`, `url`, `method`, `retryAfterMs`, `rateLimit`, `problem`, `bodyText`, `isThrottle` |
| `StoreError` | `STORE` | a store adapter failed; driver error in `cause` |
| `ValidationError` | `VALIDATION` | an item failed the schema (`onInvalid: 'fail'`); `issues` |
| `HandlerError` | `HANDLER` | wrapper used when serializing handler failures; `eventId`, `attempt`, `cause` |
| `ReplayUnavailableError` | `REPLAY_UNAVAILABLE` | `replay()` on a poller without `log` |
| `BudgetTimeoutError` | `BUDGET_TIMEOUT` | no tokens within `maxWait`; `budget` |
| `WatukuyError` | also `CIRCUIT_OPEN`, `NOT_RUNNING`, `UNKNOWN_POLLER`, `UNSUPPORTED` | generic |

`serializeError(err)` turns any thrown value into `{ name, message, code?, stack?, status?, cause? }`.

### Utilities

| Export | Description |
|---|---|
| `parseDuration(value, label?)` | `'250ms' \| '5s' \| '2m' \| '6h' \| '1d'` or a number of ms → ms. Throws `ConfigError`. |
| `formatDuration(ms)` | Compact string (`5000` → `'5s'`). |
| `sha256Hex(text)` | SHA-256 hex via Web Crypto. |
| `hashUrl(url)` | The validator key for a URL. |
| `composeHooks(sets, logger)` | Merge hook sets; errors are caught and logged. |
| `defaultLogger()` / `silentLogger` / `childLogger(base, prefix, meta)` | Logger helpers. |
| `VERSION` | Package version string. |

### Types

Cursors: `CursorConfig`, `CursorStrategyName`, `CursorValue<C>`, `TimestampCursorConfig`, `TimestampCursor`, `TokenCursorConfig`, `TokenCursor`, `PageCursorConfig`, `PageCursor`, `SnapshotDiffCursorConfig`, `CustomCursorConfig<C>`.

Pollers: `PollerConfig`, `PollerConfigWithSchema`, `PollerConfigWithoutSchema`, `PollerDefinition`, `AnyPollerDefinition`, `ResolvedPoller`, `ItemOf<P>`, `PartitionDataOf<P>`, `Partition<Data>`, `Page<Item>`, `FetchContext<Cursor, PData>`, `FetchFn`, `Lane`, `ScheduleConfig`, `BackoffConfig`, `CircuitConfig`, `DeliveryConfig`, `RetryConfig`, `PoisonConfig`, `ReconcileConfig`, `LogConfig`, `PollSummary`.

Engine: `Engine<P>`, `EngineOptions<P>`, `EngineStatus`, `PollerMap`, `BudgetConfig`, `StopOptions`, `TickOptions`, `TickResult`, `TickPollResult`, `BackfillOptions`, `ReplayOptions`, `ReplayResult`, `ResetCursorOptions`, `SubscribeOptions`, `InspectReport`, `PollerInspect`.

Events and HTTP: `WatukuyEvent<Item>`, `EventType`, `EventHandler<Item>`, `HandlerContext`, `CloudEvent<Data>`, `HttpClient`, `HttpRequestOptions`, `HttpResponse`, `QueryValue`, `RateLimitInfo`, `ProblemDetails`, `SerializedError`, `WatukuyErrorCode`.

Ports and store: `Clock`, `Random`, `Logger`, `Hooks`, `HookContext`, `StandardSchemaV1`, `Duration`, `StateStore`, `StoreCapabilities`, `RateBudgetStore`, `BudgetPolicy`, `PKey`, `Lease`, `PollerState`, `ScheduleState`, `CircuitState`, `LaneCursor`, `ItemRow`, `OutboxRow`, `OutboxStatus`, `ParkedRow`, `ParkedError`, `Validator`, `LoggedEvent`, `CommitBatch`.

## `watukuy/testing`

| Export | Description |
|---|---|
| `VirtualClock(start?)` | A `Clock` where time moves only through `advance(ms)`, `advanceTo(t)`, `runNext()`, `runAll()`, `flush()`; also `now()`, `iso()`, `pendingTimers()`, `nextDueAt()`. |
| `SeededRandom(seed)` | Reproducible `Random`: `next()`, `int(min, max)`, `pick(arr)`, `shuffle(arr)`, `chance(p)`, `fork()`. |
| `FakeApi(options)` | Scriptable in-memory API: dataset (`add`, `update`, `remove`, `get`, `all`, `seed`, `size`), listings (`listSince`, `listPage`, `listToken`, `listAll`), faults (`failNext`, `pendingFaults`, `clearFaults`), `setRateLimit`, `setEtags`, `setLatency`, request `log`, `calls`, `resetStats`, and `fetchImpl()` returning a `fetch`-compatible function serving `baseUrl` (default `https://fake.api`). |
| `fakeItems(n, factory?)` | `n` deterministic items (`item-001`, one second apart from 2026-01-01). |
| `createTestLogger()` | A `Logger` recording `entries`, with `at(level)` and `clear()`. |
| types | `FakeApiOptions`, `FakeFault`, `FakeRateLimit`, `FakeRateLimitStyle`, `FakeApiLogEntry`, `FakeSinceResult`, `FakePageResult`, `FakeTokenResult`, `FakeItem`, `TestLogger`, `TestLogEntry`, `TestLogLevel`. |

| `runChaos(options)` | Seeded deterministic simulation: random `FakeApi` mutations, random kill points, simulated restarts; returns a `ChaosReport` (`kills`, `restarts`, `delivered`, `uniqueEvents`, `duplicates`, `parked`, `violations`, `trace`). Options: `seed`, `steps` (150), `strategy` (`'timestamp'`), `killPoints` (`'all'`), `killProbability` (0.3), `maxMutationsPerStep` (3), `initialItems` (20), `concurrency` (3), `retainPayload`, `store`, `trace`. |
| `assertChaosReport(report)` | Throw with every violation, the seed, a replay hint, and the trace tail; no-op when clean. |
| `describeChaos(report)` | One-line summary for CI logs. |
| `KILL_POINTS` / `KillPoint` | `'before-acquire' \| 'after-fetch' \| 'after-commit' \| 'mid-dispatch' \| 'before-ack' \| 'after-ack-before-schedule' \| 'during-release' \| 'handler'`. |
| `FaultyStore`, `SimulatedCrash` | The store wrapper and error class the harness uses; reusable in your own crash tests. |
| `storeContractSuite({ name, create, destroy? })` | Conformance suite for `StateStore` implementations (`src/testing/store-contract.ts`; the `watukuy/testing` re-export is pending). |

## `watukuy/otel`

| Export | Description |
|---|---|
| `otelHooks({ tracer?, meter?, attributes?, recordEventIds? })` | `Hooks` emitting spans `watukuy.poll` / `.fetch` / `.commit` / `.deliver` and the metric set listed in [observability.md](./observability.md). |
| `OtelHooksOptions` | Its options type. |

## `watukuy/sinks`

| Export | Description |
|---|---|
| `webhookSink({ url, secret, headers?, fetch?, clock?, format?, timeoutMs?, successStatuses? })` | Handler that POSTs each event signed per Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`), CloudEvents body by default. |
| `bullmqSink(queue, { jobName?, jobOptions?, format? })` | Handler that enqueues with `jobId = event.id`. |
| `sqsSink(client, { queueUrl, createCommand, fifo?, format?, messageGroupId? })` | Handler that sends with `MessageDeduplicationId = event.id` on FIFO queues. |
| `kafkaSink(producer, { topic, format? })` | Handler that produces with key `event.subject`, CloudEvents binary or structured mode. |
| `signWebhook({ secret, id, timestamp, body })` | Compute a `v1,<base64>` signature. |
| `verifyWebhookSignature({ secret, id, timestamp, body, signatureHeader, now?, toleranceSec? })` | Constant-time verification for receivers. |
| `decodeWebhookSecret(secret)` | `whsec_` base64 or raw string → bytes. |
| `serializeEvent(event, format)` | `{ body, contentType }` for `'cloudevents'` or `'raw'`. |
| `WebhookDeliveryError` | `HttpError` subclass thrown on non-success receiver responses. |
| constants | `WEBHOOK_SECRET_PREFIX`, `DEFAULT_WEBHOOK_TIMEOUT_MS`, `DEFAULT_WEBHOOK_TOLERANCE_SEC`, `MAX_WEBHOOK_ERROR_BODY_CHARS`, `CLOUDEVENTS_CONTENT_TYPE`, `JSON_CONTENT_TYPE`. |
| types | `WebhookSinkOptions`, `BullMQQueueLike`, `BullMQJobOptionsLike`, `BullMQSinkOptions`, `SqsClientLike`, `SqsSendMessageInput`, `SqsMessageAttributeValue`, `SqsSinkOptions`, `KafkaProducerLike`, `KafkaMessageLike`, `KafkaSinkOptions`, `SinkFormat`, `SerializedEvent`. |

## `watukuy/store-sqlite`

| Export | Description |
|---|---|
| `SqliteStore({ path, tablePrefix?, busyTimeoutMs? })` | `StateStore` on `node:sqlite`; `path: ':memory:'` for a private in-process database. |
| `sqliteMigrations`, `SQLITE_DDL`, `SQLITE_TABLES`, `DEFAULT_TABLE_PREFIX` | DDL and table names for external migration tooling. |
| types | `SqliteStoreOptions`, `SqliteTable`. |

## `watukuy/store-postgres`

| Export | Description |
|---|---|
| `PostgresStore({ client, schema?, tablePrefix?, closeClient? })` | `StateStore` on PostgreSQL; `client` is a `pg.Pool` (or compatible) or a PGlite instance. |
| `postgresMigrations`, `postgresTableNames`, `POSTGRES_TABLES`, `DEFAULT_SCHEMA`, `DEFAULT_TABLE_PREFIX` | DDL and table names. |
| types | `PostgresStoreOptions`, `PgClientLike`, `PgPoolLike`, `PgPoolClientLike`, `PgLiteLike`, `PgQueryable`, `PgQueryResultLike`, `PostgresTable`. |

## `watukuy/store-redis`

| Export | Description |
|---|---|
| `RedisStore({ client, prefix? })` | `StateStore` on Redis with Lua-fenced writes. |
| `RedisBudgetStore({ client, prefix? })` | Distributed `RateBudgetStore` (Lua token bucket). |
| `adaptRedisClient(client)`, `fromIoredis(client)`, `fromNodeRedis(client)` | Normalize a driver to `RedisLike`. |
| types | `RedisStoreOptions`, `RedisBudgetStoreOptions`, `RedisLike`, `IoredisLikeClient`, `NodeRedisLikeClient`. |

See [stores.md](./stores.md).

## `watukuy/nestjs`

| Export | Description |
|---|---|
| `WatukuyModule.forRoot({ store, pollers?, mode?, stop?, isGlobal?, ...EngineOptions })` | Create the engine as a provider; start/stop with the app in `'daemon'` mode. |
| `WatukuyModule.forRootAsync({ imports?, inject?, useFactory, isGlobal? })` | Same, with options built from injected providers. |
| `WatukuyModule.forFeature(pollers[])` | Contribute pollers from a feature module. |
| `@OnWatukuyEvent(name)` | Method decorator: register the method as the poller's handler at bootstrap. |
| `@InjectWatukuy()` | Shorthand for `@Inject(WATUKUY_ENGINE)`. |
| `WatukuyHealthIndicator` | Terminus-compatible indicator: `isHealthy(key, { maxLagMs?, allowOpenCircuit? })`. Register it in your providers. |
| `WatukuyExplorer` | The bootstrap scanner (exported for advanced wiring). |
| tokens | `WATUKUY_ENGINE`, `WATUKUY_OPTIONS`, `WATUKUY_POLLERS`, `WATUKUY_POLLER_MAP`, `WATUKUY_EVENT_METADATA`. |
| types | `WatukuyModuleOptions`, `WatukuyModuleRootOptions`, `WatukuyModuleAsyncOptions`, `WatukuyModuleMode`, `WatukuyHealthOptions`, `WatukuyHealthData`, `WatukuyPollerHealth`, `WatukuyHealthIndicatorResult`, `OnWatukuyEventMetadata`, `OnWatukuyEventDecorator`, `WatukuyEventMethod`, `DiscoveredEventHandler`, `WatukuyFeatureModule`. |

See [nestjs.md](./nestjs.md).

## `watukuy/cli`

`npx watukuy <command>` against a config module that exports the engine (`--config ./watukuy.config.ts`, default `./watukuy.config.{ts,mts,js,mjs}`): `inspect`, `tick [--max-duration 50s]`, `run`, `trigger`, `pause`, `resume`, `backfill`, `replay`, `reset-cursor`, `parked ls|retry|discard` (all with `--poller <name> [--partition <key>]`), and `migrate` (with `--config`, or `--store sqlite --path <file>`, or `--store postgres --url <dsn>`). `--json` for machine-readable output. Programmatic: `runCli(argv, io)`. See [runbook.md](./runbook.md#cli).
