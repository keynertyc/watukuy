import { describe, expect, it } from 'vitest';
import { handlerConsumer, SubscribeConsumer } from './consumers.ts';
import type { HandlerContext, WatukuyEvent } from './event.ts';

function ev(n: number): WatukuyEvent<{ n: number }> {
  return {
    id: `e${n}`,
    type: 'created',
    source: 'urn:watukuy:t',
    subject: `s${n}`,
    time: '2026-01-01T00:00:00.000Z',
    poller: 't',
    partition: '',
    lane: 'live',
    sequence: n,
    cursor: null,
    data: { n },
    attempt: 1,
  };
}

const ctx: HandlerContext = {
  signal: new AbortController().signal,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  partition: { key: '', data: undefined },
  attempt: 1,
  ack() {},
};

describe('handlerConsumer', () => {
  it('auto mode resolves when the handler resolves', async () => {
    const seen: number[] = [];
    const c = handlerConsumer<{ n: number }>(async (e) => {
      seen.push(e.data?.n ?? -1);
    }, 'auto');
    await c.deliver(ev(1), ctx);
    expect(seen).toEqual([1]);
  });

  it('manual mode fails when ack() is not called and succeeds when it is', async () => {
    const noAck = handlerConsumer<{ n: number }>(async () => {}, 'manual');
    await expect(noAck.deliver(ev(1), ctx)).rejects.toThrow(/without calling ctx.ack/);
    const withAck = handlerConsumer<{ n: number }>(async (_e, c) => c.ack(), 'manual');
    await expect(withAck.deliver(ev(2), ctx)).resolves.toBeUndefined();
  });
});

describe('SubscribeConsumer', () => {
  it('acks an event when the consumer asks for the next one (backpressure)', async () => {
    const c = new SubscribeConsumer<{ n: number }>();
    const it1 = c[Symbol.asyncIterator]();
    let d1Done = false;
    const d1 = c.deliver(ev(1)).then(() => {
      d1Done = true;
    });
    const r1 = await it1.next();
    expect(r1.done).toBe(false);
    expect(r1.value?.data?.n).toBe(1);
    await Promise.resolve();
    expect(d1Done).toBe(false); // not acked until next() is called again
    const d2 = c.deliver(ev(2));
    const r2 = await it1.next();
    expect(r2.value?.data?.n).toBe(2);
    await d1;
    expect(d1Done).toBe(true);
    await it1.return?.();
    await d2; // return() acks the in-flight event
  });

  it('rejects the in-flight delivery when the consumer throws', async () => {
    const c = new SubscribeConsumer<{ n: number }>();
    const it1 = c[Symbol.asyncIterator]();
    const d1 = c.deliver(ev(1));
    await it1.next();
    await it1.throw?.(new Error('boom'));
    await expect(d1).rejects.toThrow('boom');
    await expect(c.deliver(ev(2))).rejects.toThrow();
  });

  it('aborting the signal closes the iterator and nacks the in-flight event', async () => {
    const ac = new AbortController();
    const c = new SubscribeConsumer<{ n: number }>(ac.signal);
    const it1 = c[Symbol.asyncIterator]();
    const d1 = c.deliver(ev(1));
    await it1.next();
    ac.abort(new Error('stop'));
    await expect(d1).rejects.toThrow('stop');
    const r = await it1.next();
    expect(r.done).toBe(true);
  });

  it('can only be iterated once', () => {
    const c = new SubscribeConsumer<{ n: number }>();
    c[Symbol.asyncIterator]();
    expect(() => c[Symbol.asyncIterator]()).toThrow(/only be iterated once/);
  });

  it('queues concurrent deliveries and hands them out in order', async () => {
    const c = new SubscribeConsumer<{ n: number }>();
    const it1 = c[Symbol.asyncIterator]();
    const deliveries = [c.deliver(ev(1)), c.deliver(ev(2)), c.deliver(ev(3))];
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await it1.next();
      got.push(r.value?.data?.n ?? -1);
    }
    await it1.return?.();
    await Promise.all(deliveries);
    expect(got).toEqual([1, 2, 3]);
  });
});
