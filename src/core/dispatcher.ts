import { backoffDelay } from '../scheduler/index.ts';
import type { Consumer } from './consumers.ts';
import { LeaseLostError, serializeError } from './errors.ts';
import type { HandlerContext, WatukuyEvent } from './event.ts';
import type { Partition, ResolvedPoller } from './poller-types.ts';
import type { Clock, Hooks, Logger, Random } from './ports.ts';
import type { Lease, OutboxRow, ParkedRow, PKey, StateStore } from './store-types.ts';

export interface DispatcherDeps {
  store: StateStore;
  clock: Clock;
  random: Random;
  logger: Logger;
  hooks: Required<Hooks>;
  poller: ResolvedPoller;
  key: PKey;
  partition: Partition<unknown>;
  instanceId: string;
  dispatchBatchSize: number;
}

export interface DrainResult {
  delivered: number;
  parked: number;
  /** Deliveries that failed and were scheduled for retry. */
  failed: number;
  /** Earliest pending retry, for the scheduler wake-up. */
  nextRetryAt: number | null;
  /** A poison event with `action: 'halt'` was hit. */
  halted: boolean;
  /** Pending rows left in the outbox after this drain. */
  remaining: number;
}

interface Group {
  key: string;
  rows: OutboxRow[];
}

function groupByOrderingKey(poller: ResolvedPoller, rows: OutboxRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const k = poller.delivery.orderingKey
      ? poller.delivery.orderingKey(row.event as WatukuyEvent<never>)
      : row.event.subject;
    let g = groups.get(k);
    if (!g) {
      g = { key: k, rows: [] };
      groups.set(k, g);
    }
    g.rows.push(row);
  }
  return Array.from(groups.values());
}

/**
 * Deliver pending outbox rows to the consumer (see docs/delivery.md): groups by ordering key, runs up to
 * `delivery.concurrency` groups in parallel, strictly sequential within a group, retries with
 * backoff via `recordAttempt`, parks poison events. Returns when nothing more can be delivered
 * right now.
 */
export async function drainOutbox(
  deps: DispatcherDeps,
  lease: Lease,
  consumer: Consumer<unknown> | null,
  signal: AbortSignal,
): Promise<DrainResult> {
  const result: DrainResult = {
    delivered: 0,
    parked: 0,
    failed: 0,
    nextRetryAt: null,
    halted: false,
    remaining: 0,
  };
  if (!consumer) {
    result.remaining = await deps.store.countPending(deps.key);
    return result;
  }
  const { poller, store, key } = deps;
  const hookCtx = { ...key, lane: 'live' as const, instanceId: deps.instanceId };

  // Groups blocked in this drain (retry pending / parked with holdKey / poison halt).
  const blocked = new Set<string>();

  // The load window widens when a whole slice is held/blocked so rows behind a parked or
  // retrying key do not starve other ordering keys.
  let window = deps.dispatchBatchSize;
  for (;;) {
    if (signal.aborted || result.halted) break;
    const rows = await store.loadPending(key, window);
    if (rows.length === 0) break;
    const held = await store.heldKeys(key);
    const groups = groupByOrderingKey(poller, rows).filter(
      (g) => !held.has(g.key) && !blocked.has(g.key),
    );
    if (groups.length === 0) {
      if (rows.length < window || window >= deps.dispatchBatchSize * 16) break;
      window *= 2;
      continue;
    }

    let progress = 0;
    const queue = groups.slice();
    const worker = async (): Promise<void> => {
      for (;;) {
        const group = queue.shift();
        if (!group || signal.aborted || result.halted) return;
        for (const row of group.rows) {
          if (signal.aborted || result.halted) return;
          const now = deps.clock.now();
          if (row.nextAttemptAt !== null && row.nextAttemptAt > now) {
            result.nextRetryAt =
              result.nextRetryAt === null
                ? row.nextAttemptAt
                : Math.min(result.nextRetryAt, row.nextAttemptAt);
            blocked.add(group.key);
            break;
          }
          const attempt = row.attempts + 1;
          const event: WatukuyEvent<unknown> = { ...row.event, attempt };
          const ctx: HandlerContext = {
            signal,
            logger: deps.logger,
            partition: deps.partition,
            attempt,
            ack() {},
          };
          const startedAt = now;
          try {
            await consumer.deliver(event, ctx);
            await store.ackEvents(key, lease, [row.eventId]);
            result.delivered++;
            progress++;
            await deps.hooks.onDelivered({
              ...hookCtx,
              lane: event.lane,
              event,
              attempt,
              durationMs: deps.clock.now() - startedAt,
            });
          } catch (err) {
            if (err instanceof LeaseLostError) throw err;
            const serialized = serializeError(err);
            if (attempt >= poller.delivery.retry.attempts) {
              const parked: ParkedRow = {
                id: row.eventId,
                kind: 'poison',
                event: row.event,
                item: undefined,
                error: {
                  ...serialized,
                  history: [
                    ...(row.lastError
                      ? [{ at: row.createdAt, message: row.lastError.message }]
                      : []),
                    { at: deps.clock.now(), message: serialized.message },
                  ],
                },
                attempts: attempt,
                parkedAt: deps.clock.now(),
                holdKey: poller.delivery.poison.holdKey ? group.key : null,
              };
              await store.parkEvent(key, lease, parked);
              result.parked++;
              progress++;
              await deps.hooks.onParked({ ...hookCtx, lane: event.lane, row: parked });
              deps.logger.warn('event parked as poison', {
                poller: key.poller,
                partition: key.partition,
                eventId: row.eventId,
                attempts: attempt,
                error: serialized.message,
              });
              if (poller.delivery.poison.action === 'halt') {
                result.halted = true;
                return;
              }
              if (poller.delivery.poison.holdKey) {
                blocked.add(group.key);
                break;
              }
            } else {
              const delay = backoffDelay(attempt, poller.delivery.retry.backoff, deps.random);
              const nextAttemptAt = deps.clock.now() + delay;
              await store.recordAttempt(key, lease, row.eventId, serialized, nextAttemptAt);
              result.failed++;
              result.nextRetryAt =
                result.nextRetryAt === null
                  ? nextAttemptAt
                  : Math.min(result.nextRetryAt, nextAttemptAt);
              await deps.hooks.onRetry({
                ...hookCtx,
                lane: event.lane,
                event,
                attempt,
                error: serialized,
                delayMs: delay,
              });
              blocked.add(group.key);
              break;
            }
          }
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(poller.delivery.concurrency, groups.length) },
      () => worker(),
    );
    await Promise.all(workers);
    if (progress === 0) break;
  }
  result.remaining = await store.countPending(key);
  return result;
}
