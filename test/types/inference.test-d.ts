import { describe, expectTypeOf, it } from 'vitest';
import {
  createWatukuy,
  definePoller,
  MemoryStore,
  type PageCursor,
  type TimestampCursor,
  type TokenCursor,
  type WatukuyEvent,
} from '../../src/index.ts';

interface Order {
  id: string;
  updatedAt: string;
  total: number;
}

describe('type inference', () => {
  it('infers the item type from identity when there is no schema', () => {
    const orders = definePoller({
      name: 'orders',
      identity: (o: Order) => o.id,
      version: (o) => {
        expectTypeOf(o).toEqualTypeOf<Order>();
        return o.updatedAt;
      },
      cursor: { strategy: 'timestamp', field: 'updatedAt', initial: null },
      fetch: async ({ cursor }) => {
        expectTypeOf(cursor).toEqualTypeOf<TimestampCursor>();
        return { items: [] as Order[] };
      },
    });
    const engine = createWatukuy({ store: new MemoryStore(), pollers: { orders } });
    engine.on('orders', (event) => {
      expectTypeOf(event).toEqualTypeOf<WatukuyEvent<Order>>();
      expectTypeOf(event.data).toEqualTypeOf<Order | undefined>();
    });
    // @ts-expect-error unknown poller names are compile errors
    engine.on('nope', () => {});
  });

  it('infers the item type from a Standard Schema and types fetch items as unknown', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => ({ value: v as Order }),
        types: undefined as { input: unknown; output: Order } | undefined,
      },
    };
    const orders = definePoller({
      name: 'orders',
      schema,
      identity: (o) => {
        expectTypeOf(o).toEqualTypeOf<Order>();
        return o.id;
      },
      cursor: { strategy: 'token', initial: null },
      fetch: async ({ cursor }) => {
        expectTypeOf(cursor).toEqualTypeOf<TokenCursor>();
        return { items: [] as unknown[], cursor: null };
      },
    });
    const engine = createWatukuy({ store: new MemoryStore(), pollers: { orders } });
    for (const _ of [engine]) {
      engine.on('orders', (event) => {
        expectTypeOf(event.data).toEqualTypeOf<Order | undefined>();
      });
    }
  });

  it('types the cursor per strategy and partition data from partitions()', () => {
    definePoller({
      name: 'pages',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'page' },
      partitions: async () => [{ key: 't1', data: { token: 'x' } }],
      fetch: async ({ cursor, partition }) => {
        expectTypeOf(cursor).toEqualTypeOf<PageCursor>();
        expectTypeOf(partition.data).toEqualTypeOf<{ token: string }>();
        return { items: [] as Order[] };
      },
    });
    definePoller({
      name: 'snap',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'snapshotDiff' },
      fetch: async ({ cursor }) => {
        expectTypeOf(cursor).toEqualTypeOf<null>();
        return { items: [] as Order[] };
      },
    });
  });

  it('subscribe() yields typed events', async () => {
    const orders = definePoller({
      name: 'orders',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'page' },
      fetch: async () => ({ items: [] as Order[] }),
    });
    const engine = createWatukuy({ store: new MemoryStore(), pollers: { orders } });
    for await (const event of engine.subscribe('orders')) {
      expectTypeOf(event).toEqualTypeOf<WatukuyEvent<Order>>();
      break;
    }
  });
});
