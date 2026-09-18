import { describe, expect, it } from 'vitest';
import { customCursor, definePoller, type Hooks, type WatukuyEvent } from '../../src/index.ts';
import { collector, engineFor, type Order, order, timestampPoller, world } from './helpers.ts';

/** Await real macrotasks so promise chains that hop through crypto.subtle settle. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('partitions (multi-tenant)', () => {
  it('each partition has its own cursor, sequence, and events carry the partition key', async () => {
    const w = world();
    const tenants = [
      { key: 't1', data: { prefix: 'a' } },
      { key: 't2', data: { prefix: 'b' } },
    ];
    w.api.add(order('a-1', w.clock));
    w.api.add(order('b-1', w.clock));
    w.api.add(order('b-2', w.clock));
    const invoices = definePoller({
      name: 'invoices',
      identity: (o: Order) => o.id,
      version: (o) => o.updatedAt,
      cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
      partitions: async () => tenants,
      fetch: async ({ cursor, partition }) => {
        const res = w.api.listSince({ since: cursor.value, afterId: cursor.tieBreak });
        return {
          items: res.items.filter((o) => o.id.startsWith(`${partition.data.prefix}-`)),
          hasMore: false,
        };
      },
      schedule: { min: '5s', max: '1m', jitter: 0 },
    });
    const engine = engineFor(w, { invoices });
    const c = collector<Order>();
    engine.on('invoices', c.handler);
    const t = await engine.tick();
    expect(t.polled.map((p) => p.partition).sort()).toEqual(['t1', 't2']);
    expect(c.events.map((e) => [e.partition, e.subject, e.sequence]).sort()).toEqual([
      ['t1', 'a-1', 1],
      ['t2', 'b-1', 1],
      ['t2', 'b-2', 2],
    ]);
    const report = await engine.inspect();
    expect(report.pollers.map((p) => p.partition).sort()).toEqual(['t1', 't2']);
    expect(await engine.partitions.list('invoices')).toEqual(tenants);
  });

  it('removed partitions are paused, not deleted; pause/resume/trigger work per partition', async () => {
    const w = world();
    let tenants = [
      { key: 't1', data: undefined },
      { key: 't2', data: undefined },
    ];
    w.api.add(order('x', w.clock));
    const p = definePoller({
      name: 'p',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'snapshotDiff' },
      partitions: () => tenants,
      partitionsRefresh: '1s',
      fetch: async () => ({ items: w.api.listAll() }),
      schedule: { min: '10s', max: '1m', jitter: 0 },
    });
    const engine = engineFor(w, { p });
    const c = collector<Order>();
    engine.on('p', c.handler);
    await engine.tick();
    expect(c.events).toHaveLength(2);
    tenants = [{ key: 't1', data: undefined }];
    await w.clock.advance(10_000);
    await engine.tick();
    const report = await engine.inspect();
    expect(report.pollers.find((x) => x.partition === 't2')).toBeUndefined();
    const t2 = await w.store.loadState({ poller: 'p', partition: 't2' });
    expect(t2?.paused).toBe(true);

    await engine.pause('p', { partition: 't1' });
    await w.clock.advance(10_000);
    const t = await engine.tick();
    expect(t.skippedNotDue).toBe(1);
    await engine.resume('p', { partition: 't1' });
    await engine.trigger('p', { partition: 't1' });
    const t3 = await engine.tick();
    expect(t3.polled).toHaveLength(1);
  });
});

describe('lanes: backfill, reconcile, replay', () => {
  it('backfill runs in its own lane from an older cursor, tagging events and skipping known versions', async () => {
    const w = world();
    // Old items exist before the poller starts at "now".
    w.api.add(order('old-1', w.clock));
    w.api.add(order('old-2', w.clock));
    await w.clock.advance(60_000);
    const startAt = w.clock.iso();
    const orders = timestampPoller(w, {
      cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: startAt },
    });
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    w.api.add(order('new-1', w.clock));
    await engine.tick();
    expect(c.ids()).toEqual(['new-1']);

    await engine.backfill('orders', { from: null });
    await engine.tick();
    const backfilled = c.events
      .filter((e) => e.lane === 'backfill')
      .map((e) => e.subject)
      .sort();
    expect(backfilled).toEqual(['old-1', 'old-2']);
    // new-1 is already known at this version → not re-emitted.
    expect(c.events.filter((e) => e.subject === 'new-1')).toHaveLength(1);
    const report = await engine.inspect();
    const bf = await w.store.loadState({ poller: 'orders', partition: '' });
    expect(bf?.lanes.backfill?.done).toBe(true);
    expect(report.pollers[0]?.outboxPending).toBe(0);
  });

  it('backfill with force re-emits known items as updated', async () => {
    const w = world({ items: 2 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    await engine.tick();
    await engine.backfill('orders', { from: null, force: true });
    await engine.tick();
    const forced = c.events.filter((e) => e.lane === 'backfill');
    expect(forced.map((e) => e.type)).toEqual(['updated', 'updated']);
  });

  it('reconcile lane detects deletes for an incremental strategy', async () => {
    const w = world({ items: 3 });
    const orders = timestampPoller(w, {
      reconcile: {
        every: '1h',
        fetch: async ({ page }: { page: number }) => {
          const res = w.api.listPage({ page, limit: 100 });
          return { items: res.items, hasMore: res.hasMore };
        },
      },
    });
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    const t1 = await engine.tick();
    // First tick runs live and the first reconcile (never run before).
    expect(t1.polled.map((p) => p.lane)).toEqual(['live', 'reconcile']);
    expect(c.events).toHaveLength(3);
    w.api.remove('o0001');
    await w.clock.advance(10_000);
    await engine.tick();
    expect(c.events.filter((e) => e.type === 'deleted')).toHaveLength(0); // not due yet
    await w.clock.advance(3_600_000);
    const t3 = await engine.tick();
    expect(t3.polled.map((p) => p.lane)).toContain('reconcile');
    const del = c.events.find((e) => e.type === 'deleted');
    expect(del).toMatchObject({ subject: 'o0001', lane: 'reconcile' });
  });

  it('replay re-emits logged events with identical ids in the replay lane', async () => {
    const w = world({ items: 2 });
    const orders = timestampPoller(w, { log: { retention: '7d' } });
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    const t0 = w.clock.now();
    await engine.tick();
    expect(c.events).toHaveLength(2);
    const { replayed } = await engine.replay('orders', { from: t0 });
    expect(replayed).toBe(2);
    await engine.tick();
    expect(c.events).toHaveLength(4);
    expect(c.events[2]?.id).toBe(c.events[0]?.id);
    expect(c.events[2]?.lane).toBe('replay');
    expect(c.events[2]?.sequence).toBe(3);
  });

  it('replay without a log throws ReplayUnavailableError', async () => {
    const w = world({ items: 1 });
    const engine = engineFor(w, { orders: timestampPoller(w) });
    await expect(engine.replay('orders', { from: 0 })).rejects.toThrow(/log: \{ retention/);
  });
});

describe('scheduler behaviour through the engine', () => {
  it('429 with Retry-After throttles without counting a failure; 5xx opens the circuit after N failures', async () => {
    const w = world({ items: 1 });
    const orders = timestampPoller(w, { circuit: { failures: 2, probeEvery: '1m' } });
    const engine = engineFor(w, { orders });
    engine.on('orders', collector().handler);
    w.api.failNext({ kind: 'http', status: 429, retryAfterMs: 20_000 });
    const t1 = await engine.tick();
    expect(t1.polled[0]?.error?.status).toBe(429);
    let st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.consecutiveFailures).toBe(0);
    expect(st?.throttledUntil).toBe(w.clock.now() + 20_000);
    expect(st?.nextDueAt).toBe(w.clock.now() + 20_000);

    await w.clock.advance(20_000);
    w.api.failNext({ kind: 'http', status: 500 }, 3);
    await engine.tick();
    st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.consecutiveFailures).toBe(1);
    expect(st?.circuit).toBe('closed');
    await w.clock.advance(15_000);
    await engine.tick();
    st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.consecutiveFailures).toBe(2);
    expect(st?.circuit).toBe('open');
    // Probe after probeEvery; API healthy again → closes.
    await w.clock.advance(60_000);
    w.api.clearFaults?.();
    const t = await engine.tick();
    expect(t.polled).toHaveLength(1);
    st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.circuit).toBe('closed');
    expect(st?.consecutiveFailures).toBe(0);
  });

  it('adaptive interval halves on events and grows when idle', async () => {
    const w = world({ items: 1 });
    const orders = timestampPoller(w, { schedule: { min: '5s', max: '40s', jitter: 0 } });
    const engine = engineFor(w, { orders });
    engine.on('orders', collector().handler);
    await engine.tick(); // events → interval stays at min (5s)
    let st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.intervalMs).toBe(5_000);
    await w.clock.advance(5_000);
    await engine.tick(); // idle → 7.5s
    st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.intervalMs).toBe(7_500);
    await w.clock.advance(7_500);
    await engine.tick(); // idle → 11.25s
    st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.intervalMs).toBe(11_250);
    w.api.update('o0000', { total: 1 });
    await w.clock.advance(11_250);
    await engine.tick(); // events → halve → 5.625s
    st = (await engine.inspect()).pollers[0]?.schedule;
    expect(st?.intervalMs).toBe(5_625);
  });

  it('shared budget bounds requests across pollers and the wait is observable', async () => {
    const w = world({ items: 5 });
    const waits: number[] = [];
    const hooks: Hooks = { onBudgetWait: (c) => void waits.push(c.waitMs) };
    const mk = (name: string) =>
      definePoller({
        name,
        identity: (o: Order) => o.id,
        version: (o) => o.updatedAt,
        cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
        budget: 'erp',
        fetch: async ({ cursor, http }) => {
          const res = await http.get('https://fake.api/since', {
            query: { since: cursor.value, after_id: cursor.tieBreak, limit: 2 },
          });
          const body = await res.json<{ data: Order[]; has_more: boolean }>();
          return { items: body.data, hasMore: body.has_more };
        },
        schedule: { min: '5s', max: '1m', jitter: 0 },
      });
    const engine = engineFor(
      w,
      { a: mk('a'), b: mk('b') },
      {
        budgets: { erp: { requests: 2, per: '10s', maxWait: '1m' } },
        fetch: w.api.fetchImpl(),
        hooks,
      },
    );
    engine.on('a', collector().handler);
    engine.on('b', collector().handler);
    // Each poller needs 3 requests (5 items, page 2). Budget: 2 per 10s. The tick must wait on tokens.
    const tick = engine.tick();
    let done = false;
    void tick.then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    // Release tokens by advancing virtual time.
    for (let i = 0; i < 6 && !done; i++) {
      await w.clock.advance(10_000);
      await settle();
    }
    expect(done).toBe(true);
    expect(w.api.calls).toBe(6);
    expect(waits.length).toBeGreaterThan(0);
  });
});

describe('HTTP helper through the engine', () => {
  it('sends ETag validators and treats 304 as an idle cycle', async () => {
    const w = world({ items: 2 });
    w.api.setEtags(true);
    const catalog = definePoller({
      name: 'catalog',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'snapshotDiff' },
      fetch: async ({ http }) => {
        const res = await http.get('https://fake.api/all');
        if (res.notModified) return { items: [] };
        const body = await res.json<{ data: Order[] }>();
        return { items: body.data };
      },
      schedule: { min: '10s', max: '1m', jitter: 0 },
    });
    const engine = engineFor(w, { catalog }, { fetch: w.api.fetchImpl() });
    const c = collector<Order>();
    engine.on('catalog', c.handler);
    await engine.tick();
    expect(c.events).toHaveLength(2);
    await w.clock.advance(10_000);
    const t2 = await engine.tick();
    expect(w.api.log.at(-1)?.status).toBe(304);
    expect(t2.polled[0]?.items).toBe(0);
    const st = (await engine.inspect()).pollers[0];
    expect(st?.lastPoll?.notModified).toBe(true);
    // 304 must NOT be treated as an empty snapshot (no deletes!).
    expect(c.events.filter((e) => e.type === 'deleted')).toHaveLength(0);
    expect(st?.items).toBe(2);
  });
});

describe('validation, schema drift, poison halt', () => {
  it('quarantines invalid items without failing the cycle', async () => {
    const w = world();
    w.api.add(order('good', w.clock));
    w.api.add(order('bad', w.clock, { total: 'NaN' as unknown as number }));
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) =>
          typeof (v as Order).total === 'number'
            ? { value: v as Order }
            : { issues: [{ message: 'total must be a number', path: ['total'] }] },
        types: undefined as { input: unknown; output: Order } | undefined,
      },
    };
    const orders = definePoller({
      name: 'orders',
      schema,
      identity: (o) => o.id,
      cursor: { strategy: 'snapshotDiff' },
      fetch: async () => ({ items: w.api.listAll() as unknown[] }),
      schedule: { min: '10s', max: '1m', jitter: 0 },
    });
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    const t = await engine.tick();
    expect(t.polled[0]?.error).toBeNull();
    expect(c.ids()).toEqual(['good']);
    const parked = await engine.parked.list('orders', { kind: 'invalid' });
    expect(parked).toHaveLength(1);
    expect(parked[0]?.error.message).toMatch(/total must be a number/);
    expect((parked[0]?.item as Order | undefined)?.id).toBe('bad');
  });

  it('bumping schemaVersion with rebaseline rewrites hashes silently; emit produces updates', async () => {
    const w = world({ items: 2 });
    const base = {
      identity: (o: Order) => o.id,
      cursor: { strategy: 'snapshotDiff' } as const,
      fetch: async () => ({ items: w.api.listAll() }),
      schedule: { min: '10s', max: '1m', jitter: 0 } as const,
    };
    const v1 = definePoller({ name: 'c', ...base, fingerprint: (o) => o.total });
    const e1 = engineFor(w, { c: v1 });
    const c1 = collector<Order>();
    e1.on('c', c1.handler);
    await e1.tick();
    expect(c1.events).toHaveLength(2);

    const v2 = definePoller({
      name: 'c',
      ...base,
      fingerprint: (o) => [o.total, o.status],
      schemaVersion: 2,
    });
    const e2 = engineFor(w, { c: v2 }, { instanceId: 'v2' });
    const c2 = collector<Order>();
    e2.on('c', c2.handler);
    await w.clock.advance(31_000);
    await e2.tick();
    expect(c2.events).toHaveLength(0); // rebaselined silently

    const v3 = definePoller({
      name: 'c',
      ...base,
      fingerprint: (o) => [o.total, o.status, o.id],
      schemaVersion: 3,
      onSchemaChange: 'emit',
    });
    const e3 = engineFor(w, { c: v3 }, { instanceId: 'v3' });
    const c3 = collector<Order>();
    e3.on('c', c3.handler);
    await w.clock.advance(31_000);
    await e3.tick();
    expect(c3.types()).toEqual(['updated', 'updated']);
  });

  it("poison action 'halt' opens the circuit instead of parking silently", async () => {
    const w = world({ items: 1 });
    const orders = timestampPoller(w, {
      delivery: { retry: { attempts: 1 }, poison: { action: 'halt' } },
    });
    const engine = engineFor(w, { orders });
    engine.on('orders', async () => {
      throw new Error('cannot process');
    });
    await engine.tick();
    const st = (await engine.inspect()).pollers[0];
    expect(st?.schedule.circuit).toBe('open');
    expect(st?.parked).toBe(1);
    expect(st?.schedule.lastError?.name).toBe('PoisonHalt');
  });
});

describe('daemon mode and operations', () => {
  it('start() polls on the virtual clock, delivers, and stop() drains', async () => {
    const w = world({ items: 2 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    await engine.start();
    expect(engine.status).toBe('running');
    await settle();
    expect(c.events).toHaveLength(2);
    await w.clock.advance(1_000);
    w.api.update('o0000', { status: 'paid' });
    await w.clock.advance(4_000);
    await settle();
    await w.clock.advance(5_000);
    await settle();
    expect(c.events.at(-1)).toMatchObject({ type: 'updated', subject: 'o0000' });
    await engine.stop();
    expect(engine.status).toBe('stopped');
    expect(w.clock.pendingTimers()).toBe(0);
  });

  it('tick maxDuration stops fetching more pages and reports timedOut', async () => {
    const w = world({ items: 500 });
    w.api.setLatency(1_000);
    const orders = definePoller({
      name: 'orders',
      identity: (o: Order) => o.id,
      version: (o) => o.updatedAt,
      cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
      fetch: async ({ cursor, http }) => {
        const res = await http.get('https://fake.api/since', {
          query: { since: cursor.value, after_id: cursor.tieBreak, limit: 100 },
        });
        const body = await res.json<{ data: Order[]; has_more: boolean }>();
        return { items: body.data, hasMore: body.has_more };
      },
      schedule: { min: '5s', max: '1m', jitter: 0 },
    });
    const engine = engineFor(w, { orders }, { fetch: w.api.fetchImpl() });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    const tick = engine.tick({ maxDuration: '2500ms' });
    // Each request takes 1s of virtual time; pump the clock until the tick resolves.
    let done = false;
    void tick.then(() => {
      done = true;
    });
    for (let i = 0; i < 20 && !done; i++) {
      await w.clock.advance(1_000);
      await settle();
    }
    const result = await tick;
    expect(c.events.length).toBeGreaterThan(0);
    expect(c.events.length).toBeLessThan(500);
    expect(result.polled[0]?.error).toBeNull();
    // The rest arrives on the next tick (truncated → due now).
    const t2 = engine.tick();
    done = false;
    void t2.then(() => {
      done = true;
    });
    for (let i = 0; i < 20 && !done; i++) {
      await w.clock.advance(1_000);
      await settle();
    }
    await t2;
    expect(c.events).toHaveLength(500);
  });

  it('resetCursor rewinds the live lane and clearSnapshot drops items', async () => {
    const w = world({ items: 2 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const c = collector<Order>();
    engine.on('orders', c.handler);
    await engine.tick();
    await engine.resetCursor('orders', { to: null, clearSnapshot: true });
    expect((await engine.inspect()).pollers[0]?.items).toBe(0);
    await engine.tick();
    expect(c.events).toHaveLength(4); // everything re-created
    expect(c.events[2]?.id).toBe(c.events[0]?.id); // same deterministic ids
  });

  it('hooks fire across the cycle', async () => {
    const w = world({ items: 1 });
    const calls: string[] = [];
    const hooks: Hooks = {
      onLeaseAcquired: () => void calls.push('lease'),
      onPollStart: () => void calls.push('start'),
      onFetch: () => void calls.push('fetch'),
      onCommit: () => void calls.push('commit'),
      onEvent: () => void calls.push('event'),
      onDelivered: () => void calls.push('delivered'),
      onScheduleChange: (c) => void calls.push(`schedule:${c.reason}`),
      onPollEnd: () => void calls.push('end'),
    };
    const engine = engineFor(w, { orders: timestampPoller(w) }, { hooks });
    engine.on('orders', collector().handler);
    await engine.tick();
    expect(calls.slice(0, 6)).toEqual(['lease', 'start', 'fetch', 'commit', 'event', 'delivered']);
    expect(calls.some((c) => c.startsWith('schedule:'))).toBe(true);
    expect(calls.at(-1)).toBe('end');
  });

  it('token and custom strategies work end to end', async () => {
    const w = world({ items: 5 });
    const tokens = definePoller({
      name: 'tokens',
      identity: (o: Order) => o.id,
      cursor: { strategy: 'token', initial: null },
      fetch: async ({ cursor }) => {
        const res = w.api.listToken({ token: cursor.value, limit: 2 });
        return { items: res.items, cursor: res.next };
      },
      schedule: { min: '5s', max: '1m', jitter: 0 },
    });
    const custom = definePoller({
      name: 'custom',
      identity: (o: Order) => o.id,
      cursor: customCursor({
        initial: { offset: 0 },
        advance: ({ cursor, items }) => ({
          cursor: { offset: cursor.offset + items.length },
          done: items.length === 0,
        }),
      }),
      fetch: async ({ cursor }) => ({
        items: w.api.listAll().slice(cursor.offset, cursor.offset + 2),
      }),
      schedule: { min: '5s', max: '1m', jitter: 0 },
    });
    const engine = engineFor(w, { tokens, custom });
    const ct = collector<Order>();
    const cc = collector<Order>();
    engine.on('tokens', ct.handler);
    engine.on('custom', cc.handler);
    await engine.tick();
    expect(ct.events).toHaveLength(5);
    expect(cc.events).toHaveLength(5);
    const ev: WatukuyEvent<Order> | undefined = cc.events[4];
    expect(ev?.subject).toBe('o0004');
  });
});
