import { describe, expect, it } from 'vitest';
import { LeaseLostError, type StateStore } from '../../src/index.ts';
import { collector, engineFor, order, snapshotPoller, timestampPoller, world } from './helpers.ts';

describe('lifecycle (timestamp strategy, tick mode)', () => {
  it('first tick emits created for every item, later ticks emit only changes', async () => {
    const w = world({ items: 5 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const c = collector<{ id: string; status: string }>();
    engine.on('orders', c.handler);

    const t1 = await engine.tick();
    expect(t1.polled).toHaveLength(1);
    expect(c.types()).toEqual(['created', 'created', 'created', 'created', 'created']);
    expect(c.events[0]?.lane).toBe('live');
    expect(c.events[0]?.partition).toBe('');
    expect(c.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    // Every event carries the cursor as of the page that produced it (PLAN §4.6).
    expect(c.events[4]?.cursor).toEqual({ value: w.clock.iso(), tieBreak: 'o0004' });

    // Not due yet: nothing happens.
    const t2 = await engine.tick();
    expect(t2.polled).toHaveLength(0);
    expect(t2.skippedNotDue).toBe(1);

    await w.clock.advance(5_000);
    const t3 = await engine.tick();
    expect(t3.polled).toHaveLength(1);
    expect(c.events).toHaveLength(5);

    await w.clock.advance(1_000);
    w.api.update('o0002', { status: 'paid' });
    await w.clock.advance(10_000);
    await engine.tick();
    expect(c.events).toHaveLength(6);
    expect(c.events[5]).toMatchObject({
      type: 'updated',
      subject: 'o0002',
      data: { status: 'paid' },
    });
    expect(c.events[5]?.previous).toBeUndefined();
  });

  it('retain: payload exposes previous on updated events', async () => {
    const w = world({ items: 1 });
    const orders = timestampPoller(w, { retain: 'payload' });
    const engine = engineFor(w, { orders });
    const c = collector<{ id: string; status: string }>();
    engine.on('orders', c.handler);
    await engine.tick();
    await w.clock.advance(5_000);
    w.api.update('o0000', { status: 'paid' });
    await w.clock.advance(5_000);
    await engine.tick();
    expect(c.events[1]).toMatchObject({
      type: 'updated',
      data: { status: 'paid' },
      previous: { status: 'open' },
    });
  });

  it('event ids are deterministic across engines and identical observations', async () => {
    const w1 = world({ items: 3 });
    const w2 = world({ items: 3 });
    const e1 = engineFor(w1, { orders: timestampPoller(w1) });
    const e2 = engineFor(w2, { orders: timestampPoller(w2) });
    const c1 = collector();
    const c2 = collector();
    e1.on('orders', c1.handler);
    e2.on('orders', c2.handler);
    await e1.tick();
    await e2.tick();
    expect(c1.events.map((e) => e.id)).toEqual(c2.events.map((e) => e.id));
    expect(c1.events[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('paginates in catch-up mode within one tick and advances the composite cursor', async () => {
    const w = world({ items: 250 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const c = collector();
    engine.on('orders', c.handler);
    const t = await engine.tick();
    expect(c.events).toHaveLength(250);
    expect(t.polled[0]?.items).toBe(250);
    const report = await engine.inspect();
    const live = report.pollers[0]?.cursors.live as { value: string; tieBreak: string | null };
    expect(live.value).toBe(w.clock.iso());
    expect(live.tieBreak).toBe('o0249');
    expect(report.pollers[0]?.lagMs).toBe(0);
  });

  it('ties at the watermark are not skipped (keyset cursor)', async () => {
    // 150 items sharing one timestamp, page size 100.
    const w = world({ items: 150 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const c = collector();
    engine.on('orders', c.handler);
    await engine.tick();
    expect(new Set(c.ids()).size).toBe(150);
  });

  it('honours maxPagesPerCycle and continues immediately (truncated → due now)', async () => {
    const w = world({ items: 250 });
    const orders = timestampPoller(w, { maxPagesPerCycle: 1 });
    const engine = engineFor(w, { orders });
    const c = collector();
    engine.on('orders', c.handler);
    await engine.tick();
    expect(c.events).toHaveLength(100);
    await engine.tick(); // due immediately
    expect(c.events).toHaveLength(200);
    await engine.tick();
    expect(c.events).toHaveLength(250);
  });
});

describe('snapshotDiff strategy', () => {
  it('detects deletes and updates without any delta support', async () => {
    const w = world({ items: 4 });
    const catalog = snapshotPoller(w);
    const engine = engineFor(w, { catalog });
    const c = collector<{ id: string }>();
    engine.on('catalog', c.handler);
    await engine.tick();
    expect(c.types()).toEqual(['created', 'created', 'created', 'created']);
    w.api.remove('o0001');
    w.api.update('o0002', { total: 99 });
    w.api.add(order('o9999', w.clock));
    await w.clock.advance(10_000);
    await engine.tick();
    const later = c.events.slice(4).map((e) => [e.type, e.subject]);
    expect(later).toContainEqual(['deleted', 'o0001']);
    expect(later).toContainEqual(['updated', 'o0002']);
    expect(later).toContainEqual(['created', 'o9999']);
    expect(later).toHaveLength(3);
    const del = c.events.find((e) => e.type === 'deleted');
    expect(del?.data).toBeUndefined(); // retain: 'hash'
  });

  it('with retain: payload, deleted events carry the last known payload', async () => {
    const w = world({ items: 1 });
    const catalog = snapshotPoller(w, { retain: 'payload' });
    const engine = engineFor(w, { catalog });
    const c = collector<{ id: string }>();
    engine.on('catalog', c.handler);
    await engine.tick();
    w.api.remove('o0000');
    await w.clock.advance(10_000);
    await engine.tick();
    expect(c.events[1]).toMatchObject({ type: 'deleted', data: { id: 'o0000' } });
  });
});

describe('delivery semantics', () => {
  it('retries a failing handler with backoff, then parks it as poison while other keys continue', async () => {
    const w = world({ items: 3 });
    const orders = timestampPoller(w, {
      delivery: {
        concurrency: 2,
        retry: { attempts: 3, backoff: { base: '1s', factor: 2, max: '10s' } },
      },
    });
    const engine = engineFor(w, { orders });
    const delivered: string[] = [];
    engine.on('orders', async (e) => {
      if (e.subject === 'o0001') throw new Error('boom');
      delivered.push(e.subject);
    });
    await engine.tick();
    expect(delivered.sort()).toEqual(['o0000', 'o0002']);
    let parked = await engine.parked.list('orders');
    expect(parked).toHaveLength(0);
    // Retry timers: 1s then 2s (jitter 0 from seeded random? full jitter → within [0, delay]); advance generously.
    await w.clock.advance(1_000);
    await engine.tick();
    await w.clock.advance(2_000);
    await engine.tick();
    await w.clock.advance(4_000);
    await engine.tick();
    parked = await engine.parked.list('orders');
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ kind: 'poison', attempts: 3, holdKey: 'o0001' });
    expect(parked[0]?.event?.subject).toBe('o0001');
    expect(parked[0]?.error.message).toBe('boom');
    const report = await engine.inspect();
    expect(report.pollers[0]?.parked).toBe(1);
    expect(report.pollers[0]?.outboxPending).toBe(0);
  });

  it('holdKey keeps later events for the parked key pending and retryParked releases them in order', async () => {
    const w = world({ items: 1 });
    const orders = timestampPoller(w, { delivery: { retry: { attempts: 1 } } });
    const engine = engineFor(w, { orders });
    let fail = true;
    const seen: string[] = [];
    engine.on('orders', async (e) => {
      if (fail) throw new Error('down');
      seen.push(`${e.type}:${e.subject}`);
    });
    await engine.tick(); // created parked immediately (attempts: 1)
    expect((await engine.parked.list('orders')).length).toBe(1);
    await w.clock.advance(5_000);
    w.api.update('o0000', { status: 'paid' });
    await w.clock.advance(5_000);
    await engine.tick(); // updated event is held behind the parked created
    expect(seen).toEqual([]);
    expect((await engine.inspect()).pollers[0]?.outboxPending).toBe(1);
    fail = false;
    const parked = await engine.parked.list('orders');
    await engine.parked.retry('orders', [parked[0]?.id as string]);
    await engine.tick();
    expect(seen).toEqual(['created:o0000', 'updated:o0000']);
  });

  it('subscribe() delivers with backpressure and acks on next()', async () => {
    const w = world({ items: 3 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    const ac = new AbortController();
    const it = engine.subscribe('orders', { signal: ac.signal })[Symbol.asyncIterator]();
    const tick = engine.tick();
    const first = await it.next();
    expect(first.value?.subject).toBe('o0000');
    const second = await it.next();
    expect(second.value?.subject).toBe('o0001');
    const third = await it.next();
    expect(third.value?.subject).toBe('o0002');
    await it.return?.();
    await tick;
    expect((await engine.inspect()).pollers[0]?.outboxPending).toBe(0);
  });

  it('events stay in the outbox until a handler is attached', async () => {
    const w = world({ items: 2 });
    const orders = timestampPoller(w);
    const engine = engineFor(w, { orders });
    await engine.tick();
    expect((await engine.inspect()).pollers[0]?.outboxPending).toBe(2);
    const c = collector();
    engine.on('orders', c.handler);
    await engine.tick(); // not due, but pending → drains
    expect(c.events).toHaveLength(2);
  });
});

describe('crash safety and multi-instance', () => {
  function crashAfterCommit(store: StateStore, times: number): StateStore {
    let remaining = times;
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'commitPoll') {
          return async (...args: Parameters<StateStore['commitPoll']>) => {
            await target.commitPoll(...args);
            if (remaining > 0) {
              remaining--;
              throw new Error('simulated crash after commit');
            }
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  it('a crash between commit and dispatch re-delivers from the outbox with identical ids (G1, G2, G9)', async () => {
    const w = world({ items: 3 });
    const crashy = crashAfterCommit(w.store, 1);
    const orders = timestampPoller(w);
    const e1 = engineFor(w, { orders }, {}, crashy);
    const c1 = collector();
    e1.on('orders', c1.handler);
    const t1 = await e1.tick();
    expect(t1.polled[0]?.error?.message).toMatch(/simulated crash/);
    expect(c1.events).toHaveLength(0);
    expect(w.api.calls).toBe(1);

    // "Restart": a fresh engine on the same (now healthy) store.
    const e2 = engineFor(w, { orders }, { instanceId: 'test-2' });
    const c2 = collector();
    e2.on('orders', c2.handler);
    await w.clock.advance(31_000); // let the crashed instance's lease expire
    await e2.tick();
    expect(c2.events).toHaveLength(3);
    expect(w.api.calls).toBe(2); // second tick polls again; nothing new, but outbox drained first
  });

  it('two engines on one store: only the lease holder polls (G5)', async () => {
    const w = world({ items: 2 });
    const store = w.store;
    const slowFetchStarted: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mk = (id: string) =>
      engineFor(
        w,
        {
          orders: timestampPoller(w, {
            fetch: async ({
              cursor,
            }: {
              cursor: { value: string | null; tieBreak: string | null };
            }) => {
              slowFetchStarted.push(id);
              await gate;
              const res = w.api.listSince({ since: cursor.value, afterId: cursor.tieBreak });
              return { items: res.items, hasMore: res.hasMore };
            },
          }),
        },
        { instanceId: id },
        store,
      );
    const a = mk('A');
    const b = mk('B');
    const ca = collector();
    const cb = collector();
    a.on('orders', ca.handler);
    b.on('orders', cb.handler);
    const ta = a.tick();
    await w.clock.flush();
    const tb = await b.tick();
    expect(tb.skippedLeased).toBe(1);
    release();
    await ta;
    expect(slowFetchStarted).toEqual(['A']);
    expect(ca.events).toHaveLength(2);
    expect(cb.events).toHaveLength(0);
  });

  it('a stale lease holder cannot write (fencing)', async () => {
    const w = world({ items: 1 });
    const key = { poller: 'orders', partition: '' };
    const l1 = await w.store.acquireLease(key, 'A', 30_000, w.clock.now());
    expect(l1?.epoch).toBe(1);
    await w.clock.advance(31_000);
    const l2 = await w.store.acquireLease(key, 'B', 30_000, w.clock.now());
    expect(l2?.epoch).toBe(2);
    await expect(
      w.store.saveState(key, l1 as NonNullable<typeof l1>, { updatedAt: w.clock.now() }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });
});
