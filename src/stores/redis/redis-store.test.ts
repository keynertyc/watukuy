import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeaseLostError, StoreError } from '../../core/errors.ts';
import type { WatukuyEvent } from '../../core/event.ts';
import type {
  CommitBatch,
  ItemRow,
  Lease,
  OutboxRow,
  ParkedRow,
  PKey,
} from '../../core/store-types.ts';
import { emptyPollerState } from '../memory/memory-store.ts';
import { adaptRedisClient, type RedisLike } from './client.ts';
import { RedisStore } from './redis-store.ts';
import { clientCases, startRedis, type TestClient } from './redis-test-harness.ts';

const redis = await startRedis();

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const KEY: PKey = { poller: 'orders', partition: 'acme' };
const NOW = 1_700_000_000_000;
const TTL = 30_000;

/** Payload shaped to catch JSON round-trip bugs: empty array, big integer, unicode, nested null. */
const PAYLOAD = {
  tags: [] as string[],
  big: 1_234_567_890_123_456,
  name: 'Zoë / 日本',
  nested: { list: [1, null, 'x'], none: null },
};

function event(seq: number, overrides: Partial<WatukuyEvent> = {}): WatukuyEvent {
  return {
    id: `evt-${seq}`,
    type: 'created',
    source: 'urn:watukuy:orders',
    subject: `item-${seq}`,
    time: new Date(NOW + seq).toISOString(),
    poller: KEY.poller,
    partition: KEY.partition,
    lane: 'live',
    sequence: seq,
    cursor: { since: seq },
    data: { id: seq, ...PAYLOAD },
    attempt: 1,
    ...overrides,
  };
}

function outboxRow(seq: number, overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    eventId: `evt-${seq}`,
    sequence: seq,
    event: event(seq),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: NOW + seq,
    ...overrides,
  };
}

function itemRow(identity: string, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    identity,
    version: 'v1',
    hash: `hash-${identity}`,
    schemaVersion: 1,
    payload: { id: identity, ...PAYLOAD },
    seenAt: NOW,
    ...overrides,
  };
}

function parkedRow(id: string, seq: number, overrides: Partial<ParkedRow> = {}): ParkedRow {
  return {
    id,
    kind: 'poison',
    event: event(seq),
    item: null,
    error: { name: 'HandlerError', message: 'boom', history: [{ at: NOW, message: 'boom' }] },
    attempts: 3,
    parkedAt: NOW + seq,
    holdKey: null,
    ...overrides,
  };
}

function batch(overrides: Partial<CommitBatch> = {}): CommitBatch {
  return { statePatch: {}, upserts: [], deletes: [], events: [], log: false, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Driver-independent unit tests
// ---------------------------------------------------------------------------------------------

describe('adaptRedisClient', () => {
  it('rejects objects that are neither ioredis nor node-redis', () => {
    expect(() => adaptRedisClient({})).toThrow(StoreError);
    expect(() => adaptRedisClient(null)).toThrow(StoreError);
    expect(() => adaptRedisClient('redis://x')).toThrow(/unsupported client/);
  });

  it('passes a RedisLike implementation through untouched', () => {
    const like = { eval: async () => null, hscanFields: async () => ({ cursor: '0', fields: [] }) };
    expect(adaptRedisClient(like)).toBe(like);
  });

  it('detects node-redis by camelCase methods and ioredis by lowercase ones', () => {
    const nodeRedis = { eval: async () => null, hGet: async () => null };
    const ioredis = { eval: async () => null, hgetall: async () => ({}) };
    expect(adaptRedisClient(nodeRedis)).not.toBe(nodeRedis);
    expect(adaptRedisClient(ioredis)).not.toBe(ioredis);
  });

  it('wraps driver failures in StoreError with the cause attached', async () => {
    const boom = new Error('ECONNRESET');
    const failing = adaptRedisClient({
      eval: async () => null,
      hgetall: async () => {
        throw boom;
      },
    });
    await expect(failing.hgetall('k')).rejects.toMatchObject({
      name: 'StoreError',
      code: 'STORE',
      cause: boom,
    });
  });

  it('normalizes hash replies from all shapes drivers use', async () => {
    const asMap: RedisLike = adaptRedisClient({
      eval: async () => null,
      hGet: async () => null,
      hGetAll: async () => new Map([['a', '1']]),
    });
    const asFlat: RedisLike = adaptRedisClient({
      eval: async () => null,
      hgetall: async () => ['a', '1', 'b', '2'],
    });
    await expect(asMap.hgetall('k')).resolves.toEqual({ a: '1' });
    await expect(asFlat.hgetall('k')).resolves.toEqual({ a: '1', b: '2' });
  });
});

// ---------------------------------------------------------------------------------------------
// Integration against a real Redis, once per driver
// ---------------------------------------------------------------------------------------------

describe.skipIf(redis === null)('RedisStore', () => {
  afterAll(async () => {
    await redis?.stop();
  });

  describe.each(clientCases)('with %s', (_name, connect) => {
    let client: TestClient;
    let store: RedisStore;

    beforeAll(async () => {
      client = await connect(redis!.url);
    });
    afterAll(async () => {
      await client.close();
    });
    beforeEach(async () => {
      await client.flush();
      store = new RedisStore({ client: client.raw });
    });

    async function acquire(owner = 'node-a', key = KEY, now = NOW): Promise<Lease> {
      const lease = await store.acquireLease(key, owner, TTL, now);
      if (!lease) throw new Error('expected lease');
      return lease;
    }

    describe('leases', () => {
      it('acquires a fresh key with epoch 1 and the requested expiry', async () => {
        const lease = await store.acquireLease(KEY, 'node-a', TTL, NOW);
        expect(lease).toEqual({ owner: 'node-a', epoch: 1, expiresAt: NOW + TTL });
        expect(await store.getLease(KEY)).toEqual(lease);
      });

      it('returns null while another owner holds an unexpired lease', async () => {
        await acquire('node-a');
        expect(await store.acquireLease(KEY, 'node-b', TTL, NOW + 1)).toBeNull();
        expect(await store.acquireLease(KEY, 'node-b', TTL, NOW + TTL - 1)).toBeNull();
      });

      it('steals an expired lease and bumps the epoch', async () => {
        const a = await acquire('node-a');
        const b = await store.acquireLease(KEY, 'node-b', TTL, NOW + TTL);
        expect(b).toEqual({ owner: 'node-b', epoch: a.epoch + 1, expiresAt: NOW + TTL + TTL });
        expect(await store.renewLease(KEY, a, TTL, NOW + TTL)).toBe(false);
      });

      it('lets the same owner re-acquire and still bumps the epoch', async () => {
        const first = await acquire('node-a');
        const again = await acquire('node-a', KEY, NOW + 5);
        expect(again.epoch).toBe(first.epoch + 1);
        expect(await store.renewLease(KEY, first, TTL, NOW + 6)).toBe(false);
        expect(await store.renewLease(KEY, again, TTL, NOW + 6)).toBe(true);
      });

      it('renews only for the current owner/epoch and moves expiresAt', async () => {
        const lease = await acquire('node-a');
        expect(await store.renewLease(KEY, lease, TTL, NOW + 10_000)).toBe(true);
        expect(await store.getLease(KEY)).toEqual({ ...lease, expiresAt: NOW + 10_000 + TTL });
        expect(await store.renewLease(KEY, { ...lease, epoch: lease.epoch + 1 }, TTL, NOW)).toBe(
          false,
        );
        expect(await store.renewLease(KEY, { ...lease, owner: 'node-b' }, TTL, NOW)).toBe(false);
      });

      it('releases only the matching lease; the epoch keeps growing afterwards', async () => {
        const lease = await acquire('node-a');
        await store.releaseLease(KEY, { ...lease, epoch: 99 });
        expect(await store.getLease(KEY)).toEqual(lease);
        await store.releaseLease(KEY, lease);
        expect(await store.getLease(KEY)).toBeNull();
        const next = await acquire('node-b');
        expect(next.epoch).toBe(lease.epoch + 1);
      });

      it('returns null from getLease for unknown keys', async () => {
        expect(await store.getLease({ poller: 'nope', partition: '' })).toBeNull();
      });
    });

    describe('fencing', () => {
      it('rejects every fenced write with LeaseLostError once the lease moved on', async () => {
        const stale = await acquire('node-a');
        await store.commitPoll(KEY, stale, batch({ events: [outboxRow(1)] }));
        const current = await store.acquireLease(KEY, 'node-b', TTL, NOW + TTL);
        expect(current).not.toBeNull();

        const expectLost = (p: Promise<unknown>) =>
          expect(p).rejects.toMatchObject({
            name: 'LeaseLostError',
            code: 'LEASE_LOST',
            poller: KEY.poller,
            partition: KEY.partition,
            epoch: stale.epoch,
          });

        await expectLost(store.saveState(KEY, stale, { paused: true }));
        await expectLost(store.commitPoll(KEY, stale, batch({ upserts: [itemRow('x')] })));
        await expectLost(store.ackEvents(KEY, stale, ['evt-1']));
        await expectLost(
          store.recordAttempt(KEY, stale, 'evt-1', { name: 'E', message: 'm' }, NOW + 1),
        );
        await expectLost(store.parkEvent(KEY, stale, parkedRow('p1', 1)));
        await expectLost(
          store.setValidator(KEY, stale, 'u1', { etag: 'e', lastModified: null, storedAt: NOW }),
        );

        // Nothing leaked from the rejected writes.
        expect(await store.loadState(KEY)).toMatchObject({ paused: false });
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.countPending(KEY)).toBe(1);
        expect((await store.loadPending(KEY, 10))[0]?.attempts).toBe(0);
        expect(await store.countParked(KEY)).toBe(0);
        expect(await store.getValidator(KEY, 'u1')).toBeNull();
      });

      it('rejects writes with the right owner but a wrong epoch, and after release', async () => {
        const lease = await acquire('node-a');
        await expect(
          store.saveState(KEY, { ...lease, epoch: lease.epoch + 1 }, { paused: true }),
        ).rejects.toBeInstanceOf(LeaseLostError);
        await store.releaseLease(KEY, lease);
        await expect(store.saveState(KEY, lease, { paused: true })).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        await expect(store.commitPoll(KEY, lease, batch())).rejects.toBeInstanceOf(LeaseLostError);
      });

      it('rejects writes on a key that has never had a lease', async () => {
        const ghost: Lease = { owner: 'ghost', epoch: 1, expiresAt: NOW + TTL };
        await expect(store.saveState(KEY, ghost, {})).rejects.toBeInstanceOf(LeaseLostError);
      });
    });

    describe('state', () => {
      it('is null until saved, then starts from the zero state with createdAt = updatedAt', async () => {
        expect(await store.loadState(KEY)).toBeNull();
        const lease = await acquire();
        await store.saveState(KEY, lease, { paused: true, updatedAt: NOW });
        expect(await store.loadState(KEY)).toEqual({
          ...emptyPollerState(NOW),
          paused: true,
        });
      });

      it('uses createdAt 0 when the first patch has no updatedAt', async () => {
        const lease = await acquire();
        await store.saveState(KEY, lease, { sequence: 7 });
        expect(await store.loadState(KEY)).toEqual({ ...emptyPollerState(0), sequence: 7 });
      });

      it('replaces provided top-level fields, keeps the others and preserves createdAt', async () => {
        const lease = await acquire();
        await store.saveState(KEY, lease, {
          lanes: {
            live: { cursor: '"a"' },
            backfill: { cursor: null, target: '"z"', done: false },
          },
          sequence: 3,
          updatedAt: NOW,
        });
        await store.saveState(KEY, lease, {
          lanes: { live: { cursor: '"b"' } },
          schedule: {
            ...emptyPollerState(0).schedule,
            nextDueAt: NOW + 60_000,
            intervalMs: 60_000,
            circuit: 'half-open',
            lastPoll: {
              lane: 'live',
              startedAt: NOW,
              durationMs: 12,
              pages: 1,
              items: 2,
              events: { created: 1, updated: 1, deleted: 0 },
              notModified: false,
              truncated: false,
            },
          },
          schemaVersion: 2,
          updatedAt: NOW + 1000,
        });
        const state = await store.loadState(KEY);
        expect(state).toMatchObject({
          lanes: { live: { cursor: '"b"' } },
          sequence: 3,
          schemaVersion: 2,
          paused: false,
          createdAt: NOW,
          updatedAt: NOW + 1000,
        });
        expect(state?.lanes.backfill).toBeUndefined();
        expect(state?.schedule.circuit).toBe('half-open');
        expect(state?.schedule.lastPoll?.events).toEqual({ created: 1, updated: 1, deleted: 0 });
      });

      it('saveStateUnfenced writes without a lease and is visible to the fenced path', async () => {
        await store.saveStateUnfenced(KEY, { paused: true, updatedAt: NOW });
        expect(await store.loadState(KEY)).toMatchObject({ paused: true, createdAt: NOW });
        const lease = await acquire();
        await store.saveState(KEY, lease, { paused: false, updatedAt: NOW + 1 });
        expect(await store.loadState(KEY)).toMatchObject({
          paused: false,
          createdAt: NOW,
          updatedAt: NOW + 1,
        });
        expect(await store.listKeys()).toEqual([KEY]);
      });
    });

    describe('commitPoll', () => {
      it('applies upserts, deletes, events, parked rows, log and state patch together', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({ upserts: [itemRow('a'), itemRow('b'), itemRow('c')] }),
        );
        await store.commitPoll(
          KEY,
          lease,
          batch({
            statePatch: { sequence: 2, lanes: { live: { cursor: '"c2"' } }, updatedAt: NOW + 2 },
            upserts: [itemRow('a', { version: 'v2', hash: 'hash-a2' }), itemRow('d')],
            deletes: ['b'],
            events: [outboxRow(1), outboxRow(2, { event: event(2, { type: 'deleted' }) })],
            parked: [parkedRow('inv-1', 0, { kind: 'invalid', event: null, item: { raw: 1 } })],
            log: true,
          }),
        );

        const versions = await store.loadVersions(KEY, ['a', 'b', 'c', 'd', 'zzz']);
        expect([...versions.keys()].sort()).toEqual(['a', 'c', 'd']);
        expect(versions.get('a')).toEqual(itemRow('a', { version: 'v2', hash: 'hash-a2' }));
        expect(await store.countItems(KEY)).toBe(3);

        const pending = await store.loadPending(KEY, 10);
        expect(pending).toEqual([
          outboxRow(1),
          outboxRow(2, { event: event(2, { type: 'deleted' }) }),
        ]);
        expect(await store.countPending(KEY)).toBe(2);

        expect(await store.listParked(KEY)).toEqual([
          parkedRow('inv-1', 0, { kind: 'invalid', event: null, item: { raw: 1 } }),
        ]);

        expect(await store.readLog(KEY, {}, 10)).toEqual([
          { sequence: 1, event: event(1), createdAt: NOW + 1 },
          { sequence: 2, event: event(2, { type: 'deleted' }), createdAt: NOW + 2 },
        ]);

        expect(await store.loadState(KEY)).toMatchObject({
          sequence: 2,
          lanes: { live: { cursor: '"c2"' } },
          updatedAt: NOW + 2,
        });
      });

      it('round-trips payloads byte-for-byte (empty arrays, big ints, unicode)', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({ upserts: [itemRow('a')], events: [outboxRow(1)] }),
        );
        expect((await store.loadVersions(KEY, ['a'])).get('a')?.payload).toEqual({
          id: 'a',
          ...PAYLOAD,
        });
        expect((await store.loadPending(KEY, 1))[0]?.event.data).toEqual({ id: 1, ...PAYLOAD });
      });

      it('does not log when the batch says so, and keeps delivered rows out of pending', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({ events: [outboxRow(1), outboxRow(2, { status: 'delivered' })], log: false }),
        );
        expect(await store.readLog(KEY, {}, 10)).toEqual([]);
        expect(await store.loadPending(KEY, 10)).toEqual([outboxRow(1)]);
        expect(await store.countPending(KEY)).toBe(1);
      });

      it('overwrites an existing event id idempotently, resetting its delivery counters', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, batch({ events: [outboxRow(1)] }));
        await store.recordAttempt(KEY, lease, 'evt-1', { name: 'E', message: 'fail' }, NOW + 9);
        expect((await store.loadPending(KEY, 10))[0]).toMatchObject({
          attempts: 1,
          nextAttemptAt: NOW + 9,
        });

        await store.commitPoll(KEY, lease, batch({ events: [outboxRow(1, { attempts: 5 })] }));
        const rows = await store.loadPending(KEY, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(outboxRow(1, { attempts: 5 }));
        expect(await store.countPending(KEY)).toBe(1);
      });

      it('is all-or-nothing: a fenced rejection persists none of the batch', async () => {
        const stale = await acquire('node-a');
        await store.acquireLease(KEY, 'node-b', TTL, NOW + TTL);
        await expect(
          store.commitPoll(
            KEY,
            stale,
            batch({
              statePatch: { sequence: 9 },
              upserts: [itemRow('a')],
              events: [outboxRow(1)],
              parked: [parkedRow('p', 1)],
              log: true,
            }),
          ),
        ).rejects.toBeInstanceOf(LeaseLostError);
        expect(await store.loadState(KEY)).toBeNull();
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.countPending(KEY)).toBe(0);
        expect(await store.countParked(KEY)).toBe(0);
        expect(await store.readLog(KEY, {}, 10)).toEqual([]);
      });

      it('handles an empty batch', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, batch());
        expect(await store.loadState(KEY)).toEqual(emptyPollerState(0));
      });
    });

    describe('outbox', () => {
      it('loadPending orders by sequence regardless of insertion order or nextAttemptAt', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({
            events: [
              outboxRow(30, { nextAttemptAt: NOW + 1 }),
              outboxRow(10, { nextAttemptAt: NOW + 999_999 }),
              outboxRow(20),
            ],
          }),
        );
        expect((await store.loadPending(KEY, 10)).map((r) => r.sequence)).toEqual([10, 20, 30]);
        expect((await store.loadPending(KEY, 2)).map((r) => r.sequence)).toEqual([10, 20]);
        expect(await store.loadPending(KEY, 0)).toEqual([]);
      });

      it('ackEvents removes rows and ignores unknown ids', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({ events: [outboxRow(1), outboxRow(2), outboxRow(3)] }),
        );
        await store.ackEvents(KEY, lease, ['evt-1', 'evt-3', 'nope']);
        expect((await store.loadPending(KEY, 10)).map((r) => r.eventId)).toEqual(['evt-2']);
        expect(await store.countPending(KEY)).toBe(1);
        await store.ackEvents(KEY, lease, []);
        expect(await store.countPending(KEY)).toBe(1);
      });

      it('recordAttempt increments attempts and stores the error and next attempt', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, batch({ events: [outboxRow(1, { attempts: 2 })] }));
        await store.recordAttempt(KEY, lease, 'evt-1', { name: 'E', message: 'one' }, NOW + 5);
        await store.recordAttempt(
          KEY,
          lease,
          'evt-1',
          { name: 'E', message: 'two', code: 'HTTP', status: 503 },
          null,
        );
        expect((await store.loadPending(KEY, 1))[0]).toEqual(
          outboxRow(1, {
            attempts: 4,
            lastError: { name: 'E', message: 'two', code: 'HTTP', status: 503 },
            nextAttemptAt: null,
          }),
        );
        // Unknown id is a no-op.
        await store.recordAttempt(KEY, lease, 'ghost', { name: 'E', message: 'x' }, null);
        expect(await store.countPending(KEY)).toBe(1);
      });
    });

    describe('parked', () => {
      it('parkEvent moves a poison event out of the outbox and lists/counts it', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, batch({ events: [outboxRow(1), outboxRow(2)] }));
        const row = parkedRow('p-2', 2, { holdKey: 'item-2' });
        await store.parkEvent(KEY, lease, row);
        expect((await store.loadPending(KEY, 10)).map((r) => r.eventId)).toEqual(['evt-1']);
        expect(await store.countPending(KEY)).toBe(1);
        expect(await store.countParked(KEY)).toBe(1);
        expect(await store.listParked(KEY)).toEqual([row]);
        expect(await store.heldKeys(KEY)).toEqual(new Set(['item-2']));
      });

      it('listParked sorts by parkedAt and filters by kind with a limit', async () => {
        const lease = await acquire();
        await store.parkEvent(KEY, lease, parkedRow('c', 3, { parkedAt: NOW + 30 }));
        await store.parkEvent(KEY, lease, parkedRow('a', 1, { parkedAt: NOW + 10 }));
        await store.parkEvent(
          KEY,
          lease,
          parkedRow('b', 2, {
            parkedAt: NOW + 20,
            kind: 'invalid',
            event: null,
            item: { bad: true },
          }),
        );
        expect((await store.listParked(KEY)).map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect((await store.listParked(KEY, { kind: 'poison' })).map((r) => r.id)).toEqual([
          'a',
          'c',
        ]);
        expect((await store.listParked(KEY, { kind: 'invalid' })).map((r) => r.id)).toEqual(['b']);
        expect((await store.listParked(KEY, { limit: 2 })).map((r) => r.id)).toEqual(['a', 'b']);
      });

      it('heldKeys reflects only rows with a holdKey and follows discard/retry', async () => {
        const lease = await acquire();
        await store.parkEvent(KEY, lease, parkedRow('a', 1, { holdKey: 'k1' }));
        await store.parkEvent(KEY, lease, parkedRow('b', 2, { holdKey: 'k2' }));
        await store.parkEvent(KEY, lease, parkedRow('c', 3, { holdKey: null }));
        await store.parkEvent(KEY, lease, parkedRow('d', 4, { holdKey: 'k1' }));
        expect(await store.heldKeys(KEY)).toEqual(new Set(['k1', 'k2']));
        expect(await store.discardParked(KEY, ['a'])).toBe(1);
        expect(await store.heldKeys(KEY)).toEqual(new Set(['k1', 'k2']));
        expect(await store.retryParked(KEY, ['d'])).toBe(1);
        expect(await store.heldKeys(KEY)).toEqual(new Set(['k2']));
      });

      it('retryParked re-inserts poison rows as fresh pending rows and skips the rest', async () => {
        const lease = await acquire();
        const poison = parkedRow('p', 7, { attempts: 4, parkedAt: NOW + 700 });
        const invalid = parkedRow('i', 8, { kind: 'invalid', event: null, item: { x: 1 } });
        await store.parkEvent(KEY, lease, poison);
        await store.parkEvent(KEY, lease, invalid);
        expect(await store.retryParked(KEY, ['p', 'i', 'missing'])).toBe(1);
        expect(await store.loadPending(KEY, 10)).toEqual([
          {
            eventId: 'evt-7',
            sequence: 7,
            event: event(7),
            status: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            createdAt: NOW + 700,
          },
        ]);
        expect((await store.listParked(KEY)).map((r) => r.id)).toEqual(['i']);
        expect(await store.retryParked(KEY, [])).toBe(0);
      });

      it('retryParked resets delivery counters left over from an earlier life of the event', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, batch({ events: [outboxRow(1)] }));
        await store.recordAttempt(KEY, lease, 'evt-1', { name: 'E', message: 'm' }, NOW + 1);
        await store.parkEvent(KEY, lease, parkedRow('p', 1));
        expect(await store.retryParked(KEY, ['p'])).toBe(1);
        expect((await store.loadPending(KEY, 1))[0]).toMatchObject({
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
        });
      });

      it('discardParked returns how many rows were removed', async () => {
        const lease = await acquire();
        await store.parkEvent(KEY, lease, parkedRow('a', 1));
        await store.parkEvent(KEY, lease, parkedRow('b', 2));
        expect(await store.discardParked(KEY, ['a', 'zzz'])).toBe(1);
        expect(await store.discardParked(KEY, ['a'])).toBe(0);
        expect(await store.countParked(KEY)).toBe(1);
        expect(await store.discardParked(KEY, [])).toBe(0);
      });
    });

    describe('validators', () => {
      it('stores and overwrites validators per url hash', async () => {
        const lease = await acquire();
        expect(await store.getValidator(KEY, 'u1')).toBeNull();
        await store.setValidator(KEY, lease, 'u1', {
          etag: '"e1"',
          lastModified: null,
          storedAt: NOW,
        });
        await store.setValidator(KEY, lease, 'u2', {
          etag: null,
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          storedAt: NOW,
        });
        expect(await store.getValidator(KEY, 'u1')).toEqual({
          etag: '"e1"',
          lastModified: null,
          storedAt: NOW,
        });
        await store.setValidator(KEY, lease, 'u1', {
          etag: '"e2"',
          lastModified: null,
          storedAt: NOW + 1,
        });
        expect(await store.getValidator(KEY, 'u1')).toMatchObject({ etag: '"e2"' });
        expect(await store.getValidator(KEY, 'u2')).toMatchObject({
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
        });
      });
    });

    describe('log', () => {
      async function seedLog(): Promise<Lease> {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({
            events: [1, 2, 3, 4, 5].map((s) => outboxRow(s, { createdAt: NOW + s * 1000 })),
            log: true,
          }),
        );
        return lease;
      }

      it('reads in sequence order with afterSequence / time bounds / limit', async () => {
        await seedLog();
        const seqs = async (range: Parameters<RedisStore['readLog']>[1], limit = 10) =>
          (await store.readLog(KEY, range, limit)).map((e) => e.sequence);
        expect(await seqs({})).toEqual([1, 2, 3, 4, 5]);
        expect(await seqs({ afterSequence: 2 })).toEqual([3, 4, 5]);
        expect(await seqs({ fromTime: NOW + 2000 })).toEqual([2, 3, 4, 5]);
        expect(await seqs({ toTime: NOW + 3000 })).toEqual([1, 2, 3]);
        expect(await seqs({ fromTime: NOW + 2000, toTime: NOW + 4000 })).toEqual([2, 3, 4]);
        expect(await seqs({ afterSequence: 1, fromTime: NOW + 3000 }, 2)).toEqual([3, 4]);
        expect(await seqs({}, 0)).toEqual([]);
      });

      it('survives ack and parking (the log is independent of the outbox)', async () => {
        const lease = await seedLog();
        await store.ackEvents(KEY, lease, ['evt-1', 'evt-2']);
        await store.parkEvent(KEY, lease, parkedRow('p', 3));
        expect((await store.readLog(KEY, {}, 10)).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
      });

      it('prunes entries older than the cutoff and reports the count', async () => {
        await seedLog();
        expect(await store.pruneLog(KEY, NOW + 3000)).toBe(2);
        expect((await store.readLog(KEY, {}, 10)).map((e) => e.sequence)).toEqual([3, 4, 5]);
        expect(await store.pruneLog(KEY, NOW)).toBe(0);
        expect(await store.pruneLog(KEY, NOW + 999_999)).toBe(3);
        expect(await store.readLog(KEY, {}, 10)).toEqual([]);
      });

      it('pages through logs larger than one ZRANGE page', async () => {
        const lease = await acquire();
        const events = Array.from({ length: 1200 }, (_, i) =>
          outboxRow(i + 1, { createdAt: NOW + i }),
        );
        await store.commitPoll(KEY, lease, batch({ events, log: true }));
        const all = await store.readLog(KEY, {}, 2000);
        expect(all).toHaveLength(1200);
        expect(all[0]?.sequence).toBe(1);
        expect(all[1199]?.sequence).toBe(1200);
        const late = await store.readLog(KEY, { fromTime: NOW + 1100 }, 50);
        expect(late.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => 1101 + i));
        expect(await store.pruneLog(KEY, NOW + 1000)).toBe(1000);
        expect(await store.readLog(KEY, {}, 10)).toHaveLength(10);
      });
    });

    describe('keys', () => {
      const other: PKey = { poller: 'invoices', partition: '' };

      it('listKeys returns every key written, optionally filtered by poller', async () => {
        expect(await store.listKeys()).toEqual([]);
        await acquire('node-a', KEY);
        await store.saveStateUnfenced(other, { paused: true });
        await store.saveStateUnfenced({ poller: 'orders', partition: 'beta' }, {});
        expect(await store.listKeys()).toEqual([
          other,
          { poller: 'orders', partition: 'acme' },
          { poller: 'orders', partition: 'beta' },
        ]);
        expect(await store.listKeys('orders')).toEqual([
          { poller: 'orders', partition: 'acme' },
          { poller: 'orders', partition: 'beta' },
        ]);
        expect(await store.listKeys('nope')).toEqual([]);
      });

      it('deleteKey removes every row for the key and unregisters it', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({
            statePatch: { sequence: 1 },
            upserts: [itemRow('a')],
            events: [outboxRow(1), outboxRow(2)],
            parked: [parkedRow('p', 3, { holdKey: 'h' })],
            log: true,
          }),
        );
        await store.recordAttempt(KEY, lease, 'evt-1', { name: 'E', message: 'm' }, null);
        await store.setValidator(KEY, lease, 'u', { etag: 'e', lastModified: null, storedAt: NOW });
        await store.saveStateUnfenced(other, { paused: true });
        expect((await client.keys('watukuy:p:orders:acme*')).length).toBeGreaterThan(5);

        await store.deleteKey(KEY);

        expect(await client.keys('watukuy:p:orders:acme*')).toEqual([]);
        expect(await store.loadState(KEY)).toBeNull();
        expect(await store.getLease(KEY)).toBeNull();
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.countPending(KEY)).toBe(0);
        expect(await store.countParked(KEY)).toBe(0);
        expect(await store.heldKeys(KEY)).toEqual(new Set());
        expect(await store.getValidator(KEY, 'u')).toBeNull();
        expect(await store.readLog(KEY, {}, 10)).toEqual([]);
        expect(await store.listKeys()).toEqual([other]);
        // The other key is untouched.
        expect(await store.loadState(other)).toMatchObject({ paused: true });
        // Deleting again is harmless.
        await store.deleteKey(KEY);
      });

      it('clearItems drops the snapshot only', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({
            statePatch: { sequence: 2 },
            upserts: [itemRow('a'), itemRow('b')],
            events: [outboxRow(1)],
          }),
        );
        await store.clearItems(KEY);
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.loadVersions(KEY, ['a'])).toEqual(new Map());
        expect(await store.countPending(KEY)).toBe(1);
        expect(await store.loadState(KEY)).toMatchObject({ sequence: 2 });
        expect(await store.getLease(KEY)).toEqual(lease);
      });

      it('encodes unusual poller/partition names and keeps them apart', async () => {
        const weird: PKey = { poller: 'a:b c', partition: 'x/y:z%?' };
        const sibling: PKey = { poller: 'a:b c', partition: 'x/y' };
        const lease = await acquire('n', weird);
        await store.commitPoll(weird, lease, batch({ upserts: [itemRow('1')] }));
        expect(await store.countItems(weird)).toBe(1);
        expect(await store.countItems(sibling)).toBe(0);
        expect(await store.listKeys()).toEqual([weird]);
        await store.deleteKey(weird);
        expect(await store.listKeys()).toEqual([]);
      });

      it('honours a custom prefix and isolates stores with different prefixes', async () => {
        const a = new RedisStore({ client: client.raw, prefix: 'tenant-a:' });
        const b = new RedisStore({ client: client.raw, prefix: 'tenant-b:' });
        const la = await a.acquireLease(KEY, 'n', TTL, NOW);
        const lb = await b.acquireLease(KEY, 'n', TTL, NOW);
        expect(la?.epoch).toBe(1);
        expect(lb?.epoch).toBe(1);
        await a.commitPoll(KEY, la!, batch({ upserts: [itemRow('a')] }));
        expect(await a.countItems(KEY)).toBe(1);
        expect(await b.countItems(KEY)).toBe(0);
        expect(await store.countItems(KEY)).toBe(0);
        expect((await client.keys('tenant-a:*')).length).toBeGreaterThan(0);
        expect(await client.keys('watukuy:*')).toEqual([]);
      });
    });

    describe('streamIdentities', () => {
      it('yields every identity exactly once in batches of the requested size', async () => {
        const lease = await acquire();
        const ids = Array.from({ length: 2500 }, (_, i) => `item-${String(i).padStart(5, '0')}`);
        // Commit in chunks to keep individual EVAL argument lists moderate.
        for (let i = 0; i < ids.length; i += 1000) {
          await store.commitPoll(
            KEY,
            lease,
            batch({ upserts: ids.slice(i, i + 1000).map((id) => itemRow(id)) }),
          );
        }
        expect(await store.countItems(KEY)).toBe(2500);

        const batches: string[][] = [];
        for await (const b of store.streamIdentities(KEY, 400)) batches.push(b);
        expect(batches.map((b) => b.length)).toEqual([400, 400, 400, 400, 400, 400, 100]);
        const seen = batches.flat();
        expect(new Set(seen).size).toBe(2500);
        expect(seen.sort()).toEqual(ids);
      });

      it('uses a default batch size and yields nothing for an empty snapshot', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          batch({ upserts: Array.from({ length: 1500 }, (_, i) => itemRow(`i${i}`)) }),
        );
        const sizes: number[] = [];
        for await (const b of store.streamIdentities(KEY)) sizes.push(b.length);
        expect(sizes).toEqual([1000, 500]);

        const none: string[][] = [];
        for await (const b of store.streamIdentities({ poller: 'empty', partition: '' }))
          none.push(b);
        expect(none).toEqual([]);
      });
    });

    describe('isolation', () => {
      it('keeps partitions of one poller and different pollers independent', async () => {
        const p1: PKey = { poller: 'orders', partition: 'one' };
        const p2: PKey = { poller: 'orders', partition: 'two' };
        const q: PKey = { poller: 'orders-archive', partition: 'one' };
        const l1 = await acquire('a', p1);
        const l2 = await acquire('b', p2);
        const lq = await acquire('c', q);
        expect([l1.epoch, l2.epoch, lq.epoch]).toEqual([1, 1, 1]);

        await store.commitPoll(p1, l1, batch({ upserts: [itemRow('x')], events: [outboxRow(1)] }));
        await store.commitPoll(p2, l2, batch({ upserts: [itemRow('y'), itemRow('z')] }));
        await store.parkEvent(q, lq, parkedRow('p', 1, { holdKey: 'h' }));

        expect(await store.countItems(p1)).toBe(1);
        expect(await store.countItems(p2)).toBe(2);
        expect(await store.countItems(q)).toBe(0);
        expect(await store.countPending(p1)).toBe(1);
        expect(await store.countPending(p2)).toBe(0);
        expect(await store.heldKeys(q)).toEqual(new Set(['h']));
        expect(await store.heldKeys(p1)).toEqual(new Set());

        // A lease on p1 does not fence writes on p2.
        await expect(store.saveState(p2, l1, { paused: true })).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        await store.saveState(p2, l2, { paused: true });
        expect(await store.loadState(p1)).toMatchObject({ paused: false });
        expect(await store.loadState(p2)).toMatchObject({ paused: true });
      });
    });

    describe('lifecycle', () => {
      it('migrate() and close() are no-ops that leave the client usable', async () => {
        await store.migrate();
        const lease = await acquire();
        await store.close();
        await store.commitPoll(KEY, lease, batch({ upserts: [itemRow('a')] }));
        expect(await store.countItems(KEY)).toBe(1);
        expect(store.capabilities).toEqual({ transactions: true, log: true, streaming: true });
      });
    });
  });
});
