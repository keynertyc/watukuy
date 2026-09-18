import type { CursorConfig } from './cursor-types.ts';
import { type Duration, parseDuration } from './duration.ts';
import { ConfigError } from './errors.ts';
import type {
  BackoffConfig,
  PollerConfigWithoutSchema,
  PollerConfigWithSchema,
  PollerDefinition,
  ResolvedPoller,
} from './poller-types.ts';
import type { StandardSchemaV1 } from './standard-schema.ts';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Declare a poller: how to fetch and how to identify items. Everything else (cursors, diffing,
 * scheduling, delivery) is owned by the engine. Validates eagerly and applies defaults.
 *
 * @example
 * const orders = definePoller({
 *   name: 'orders',
 *   identity: (o: Order) => o.id,
 *   version: (o) => o.updatedAt,
 *   cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
 *   fetch: async ({ cursor, http }) => {
 *     const res = await http.get('https://erp.example.com/orders', { query: { since: cursor.value } });
 *     return { items: await res.json<Order[]>() };
 *   },
 *   schedule: { min: '5s', max: '5m' },
 * });
 */
export function definePoller<
  const Name extends string,
  S extends StandardSchemaV1,
  const C extends CursorConfig,
  PData = undefined,
>(
  config: PollerConfigWithSchema<Name, S, C, PData>,
): PollerDefinition<Name, StandardSchemaV1.InferOutput<S>, C, PData>;
/** Without a schema: the item type comes from the `identity` parameter and `fetch` must return typed items. */
export function definePoller<
  const Name extends string,
  Item,
  const C extends CursorConfig,
  PData = undefined,
>(config: PollerConfigWithoutSchema<Name, Item, C, PData>): PollerDefinition<Name, Item, C, PData>;
export function definePoller(
  config:
    | PollerConfigWithSchema<string, StandardSchemaV1, CursorConfig, unknown>
    | PollerConfigWithoutSchema<string, unknown, CursorConfig, unknown>,
): PollerDefinition<string, unknown, CursorConfig, unknown> {
  const resolved = resolvePoller(config);
  return Object.freeze({ kind: 'watukuy.poller' as const, name: resolved.name, resolved });
}

type AnyConfig =
  | PollerConfigWithSchema<string, StandardSchemaV1, CursorConfig, unknown>
  | PollerConfigWithoutSchema<string, unknown, CursorConfig, unknown>;

function backoff(
  cfg: BackoffConfig | undefined,
  defaults: { base: Duration; factor: number; max: Duration },
  label: string,
): { baseMs: number; factor: number; maxMs: number } {
  const baseMs = parseDuration(cfg?.base ?? defaults.base, `${label}.backoff.base`);
  const maxMs = parseDuration(cfg?.max ?? defaults.max, `${label}.backoff.max`);
  const factor = cfg?.factor ?? defaults.factor;
  if (!(factor >= 1)) throw new ConfigError(`${label}.backoff.factor must be >= 1`);
  if (maxMs < baseMs) throw new ConfigError(`${label}.backoff.max must be >= base`);
  return { baseMs, factor, maxMs };
}

function validateCursor(cursor: CursorConfig, name: string): void {
  if (!cursor || typeof cursor !== 'object') {
    throw new ConfigError(`poller '${name}': cursor is required`);
  }
  switch (cursor.strategy) {
    case 'timestamp':
      if (!cursor.field)
        throw new ConfigError(`poller '${name}': cursor.field is required for timestamp strategy`);
      if (cursor.initial !== null && typeof cursor.initial !== 'string') {
        throw new ConfigError(`poller '${name}': cursor.initial must be a string or null`);
      }
      if (cursor.lag !== undefined) parseDuration(cursor.lag, `poller '${name}' cursor.lag`);
      if (cursor.overlap !== undefined)
        parseDuration(cursor.overlap, `poller '${name}' cursor.overlap`);
      return;
    case 'token':
      if (cursor.initial !== null && typeof cursor.initial !== 'string') {
        throw new ConfigError(`poller '${name}': cursor.initial must be a string or null`);
      }
      return;
    case 'page':
      if (
        cursor.initial !== undefined &&
        !(Number.isInteger(cursor.initial) && cursor.initial >= 0)
      ) {
        throw new ConfigError(`poller '${name}': cursor.initial must be a non-negative integer`);
      }
      return;
    case 'snapshotDiff':
      return;
    case 'custom':
      if (typeof cursor.advance !== 'function') {
        throw new ConfigError(`poller '${name}': custom cursor requires advance()`);
      }
      return;
    default:
      throw new ConfigError(
        `poller '${name}': unknown cursor strategy ${JSON.stringify((cursor as { strategy?: unknown }).strategy)}`,
      );
  }
}

/** @internal */
export function resolvePoller(config: AnyConfig): ResolvedPoller {
  if (!config || typeof config !== 'object')
    throw new ConfigError('definePoller(config) requires an object');
  const name = config.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ConfigError(
      `poller name must match ${NAME_RE} (letters, digits, '.', '_', '-'; max 128 chars), got ${JSON.stringify(name)}`,
    );
  }
  if (typeof config.identity !== 'function')
    throw new ConfigError(`poller '${name}': identity() is required`);
  if (typeof config.fetch !== 'function')
    throw new ConfigError(`poller '${name}': fetch() is required`);
  validateCursor(config.cursor, name);

  const schema = config.schema;
  if (schema !== undefined) {
    const std = (schema as StandardSchemaV1)['~standard'];
    if (!std || std.version !== 1 || typeof std.validate !== 'function') {
      throw new ConfigError(
        `poller '${name}': schema must implement Standard Schema v1 ('~standard'.validate)`,
      );
    }
  }

  const schedule = config.schedule ?? { min: '30s', max: '5m' };
  const minMs = parseDuration(schedule.min, `poller '${name}' schedule.min`);
  const maxMs = parseDuration(schedule.max, `poller '${name}' schedule.max`);
  if (minMs <= 0) throw new ConfigError(`poller '${name}': schedule.min must be > 0`);
  if (maxMs < minMs)
    throw new ConfigError(`poller '${name}': schedule.max must be >= schedule.min`);
  const jitter = schedule.jitter ?? 0.1;
  if (!(jitter >= 0 && jitter < 1))
    throw new ConfigError(`poller '${name}': schedule.jitter must be in [0, 1)`);

  const delivery = config.delivery ?? {};
  const concurrency = delivery.concurrency ?? 1;
  if (!(Number.isInteger(concurrency) && concurrency >= 1)) {
    throw new ConfigError(`poller '${name}': delivery.concurrency must be an integer >= 1`);
  }
  const attempts = delivery.retry?.attempts ?? 5;
  if (!(Number.isInteger(attempts) && attempts >= 1)) {
    throw new ConfigError(`poller '${name}': delivery.retry.attempts must be an integer >= 1`);
  }

  const schemaVersion = config.schemaVersion ?? 1;
  if (!(Number.isInteger(schemaVersion) && schemaVersion >= 1)) {
    throw new ConfigError(`poller '${name}': schemaVersion must be an integer >= 1`);
  }

  const maxPagesPerCycle = config.maxPagesPerCycle ?? 50;
  if (!(Number.isInteger(maxPagesPerCycle) && maxPagesPerCycle >= 1)) {
    throw new ConfigError(`poller '${name}': maxPagesPerCycle must be an integer >= 1`);
  }

  const circuitFailures = config.circuit?.failures ?? 5;
  if (!(Number.isInteger(circuitFailures) && circuitFailures >= 1)) {
    throw new ConfigError(`poller '${name}': circuit.failures must be an integer >= 1`);
  }

  const budgetWeight = config.budgetWeight ?? 1;
  if (!(budgetWeight > 0)) throw new ConfigError(`poller '${name}': budgetWeight must be > 0`);
  const budgetCost = config.budgetCost ?? 1;
  if (!(budgetCost >= 0)) throw new ConfigError(`poller '${name}': budgetCost must be >= 0`);

  if (config.reconcile && config.cursor.strategy === 'snapshotDiff') {
    throw new ConfigError(
      `poller '${name}': reconcile is redundant with snapshotDiff (it already detects deletes)`,
    );
  }
  if (config.reconcile && typeof config.reconcile.fetch !== 'function') {
    throw new ConfigError(`poller '${name}': reconcile.fetch() is required`);
  }

  return {
    name,
    source: config.source ?? `urn:watukuy:${name}`,
    schema: schema as StandardSchemaV1 | undefined,
    identity: config.identity as ResolvedPoller['identity'],
    version: config.version as ResolvedPoller['version'],
    fingerprint: config.fingerprint as ResolvedPoller['fingerprint'],
    schemaVersion,
    cursor: config.cursor,
    fetch: config.fetch as ResolvedPoller['fetch'],
    schedule: {
      minMs,
      maxMs,
      adaptive: schedule.adaptive ?? true,
      jitter,
      backoff: backoff(
        schedule.backoff,
        { base: '1s', factor: 2, max: '10m' },
        `poller '${name}' schedule`,
      ),
    },
    budget: config.budget,
    budgetWeight,
    budgetCost,
    partitions: config.partitions as ResolvedPoller['partitions'],
    partitionsRefreshMs: parseDuration(
      config.partitionsRefresh ?? '5m',
      `poller '${name}' partitionsRefresh`,
    ),
    delivery: {
      orderingKey: delivery.orderingKey as ResolvedPoller['delivery']['orderingKey'],
      concurrency,
      retry: {
        attempts,
        backoff: backoff(
          delivery.retry?.backoff,
          { base: '1s', factor: 2, max: '2m' },
          `poller '${name}' delivery.retry`,
        ),
      },
      poison: {
        action: delivery.poison?.action ?? 'park',
        holdKey: delivery.poison?.holdKey ?? true,
      },
      ackMode: delivery.ackMode ?? 'auto',
    },
    retain: config.retain ?? 'hash',
    reconcile: config.reconcile
      ? {
          everyMs: parseDuration(config.reconcile.every, `poller '${name}' reconcile.every`),
          fetch: config.reconcile.fetch as NonNullable<ResolvedPoller['reconcile']>['fetch'],
        }
      : undefined,
    onInvalid: config.onInvalid ?? 'quarantine',
    onSchemaChange: config.onSchemaChange ?? 'rebaseline',
    maxPagesPerCycle,
    circuit: {
      failures: circuitFailures,
      probeEveryMs:
        config.circuit?.probeEvery !== undefined
          ? parseDuration(config.circuit.probeEvery, `poller '${name}' circuit.probeEvery`)
          : maxMs,
    },
    log: config.log
      ? { retentionMs: parseDuration(config.log.retention, `poller '${name}' log.retention`) }
      : undefined,
  };
}

/** Type guard for values produced by `definePoller`. */
export function isPollerDefinition(value: unknown): value is PollerDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'watukuy.poller' &&
    typeof (value as { resolved?: unknown }).resolved === 'object'
  );
}
