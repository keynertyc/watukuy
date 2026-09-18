import type { EngineOptions, PollerMap, StateStore, WatukuyEvent } from '../../src/index.ts';
import { createWatukuy, definePoller, MemoryStore } from '../../src/index.ts';
import { createTestLogger, FakeApi, SeededRandom, VirtualClock } from '../../src/testing/index.ts';

export interface Order {
  id: string;
  updatedAt: string;
  status: string;
  total: number;
  [k: string]: unknown;
}

export function order(id: string, clock: VirtualClock, patch: Partial<Order> = {}): Order {
  return { id, updatedAt: clock.iso(), status: 'open', total: 10, ...patch };
}

export function world(opts: { seed?: number; start?: string; items?: number } = {}) {
  const clock = new VirtualClock(opts.start ?? '2026-01-01T00:00:00Z');
  const random = new SeededRandom(opts.seed ?? 42);
  const api = new FakeApi<Order>({
    clock,
    identity: (o) => o.id,
    timestampField: 'updatedAt',
    pageSize: 100,
  });
  for (let i = 0; i < (opts.items ?? 0); i++) {
    api.add(order(`o${String(i).padStart(4, '0')}`, clock));
  }
  const store = new MemoryStore();
  const logger = createTestLogger();
  return { clock, random, api, store, logger };
}

export type World = ReturnType<typeof world>;

/** Timestamp poller reading the FakeApi directly (no HTTP). */
export function timestampPoller(w: World, extra: Record<string, unknown> = {}) {
  return definePoller({
    name: 'orders',
    identity: (o: Order) => o.id,
    version: (o) => o.updatedAt,
    cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
    fetch: async ({ cursor }) => {
      const res = w.api.listSince({ since: cursor.value, afterId: cursor.tieBreak, limit: 100 });
      return { items: res.items, hasMore: res.hasMore };
    },
    schedule: { min: '5s', max: '1m', jitter: 0 },
    ...(extra as object),
  });
}

/** snapshotDiff poller over the FakeApi page endpoint. */
export function snapshotPoller(w: World, extra: Record<string, unknown> = {}) {
  return definePoller({
    name: 'catalog',
    identity: (o: Order) => o.id,
    cursor: { strategy: 'snapshotDiff' },
    fetch: async ({ page }) => {
      const res = w.api.listPage({ page, limit: 100 });
      return { items: res.items, hasMore: res.hasMore };
    },
    schedule: { min: '10s', max: '1m', jitter: 0 },
    ...(extra as object),
  });
}

export function engineFor<P extends PollerMap>(
  w: World,
  pollers: P,
  extra: Partial<EngineOptions<P>> = {},
  store: StateStore = w.store,
) {
  return createWatukuy<P>({
    store,
    pollers,
    clock: w.clock,
    random: w.random,
    logger: w.logger,
    instanceId: extra.instanceId ?? 'test-1',
    lease: { ttl: '30s' },
    ...extra,
  });
}

export function collector<Item>() {
  const events: WatukuyEvent<Item>[] = [];
  const handler = async (event: WatukuyEvent<Item>): Promise<void> => {
    events.push(event);
  };
  return {
    events,
    handler,
    types: () => events.map((e) => e.type),
    ids: () => events.map((e) => e.subject),
  };
}
