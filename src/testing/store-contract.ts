import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeaseLostError } from '../core/errors.ts';
import type { WatukuyEvent } from '../core/event.ts';
import type {
  CommitBatch,
  ItemRow,
  Lease,
  OutboxRow,
  ParkedRow,
  PKey,
  PollerState,
  StateStore,
} from '../core/store-types.ts';

/** Options for {@link storeContractSuite}. */
export interface StoreContractOptions {
  /** Name shown in the reporter, for example `'SqliteStore'`. */
  name: string;
  /**
   * Build a fresh, empty store. Called before every test; the suite calls `migrate()` on the
   * result before using it.
   */
  create(): Promise<StateStore> | StateStore;
  /**
   * Tear a store down after each test. Defaults to `store.close()`. Use it to drop tables or
   * delete temp files when `create()` allocates them. Log tests are skipped automatically when
   * `store.capabilities.log` is `false`.
   */
  destroy?(store: StateStore): Promise<void> | void;
}

const T0 = Date.UTC(2026, 0, 1);
const TTL = 30_000;
const KEY: PKey = { poller: 'orders', partition: '' };
const KEY_B: PKey = { poller: 'orders', partition: 'tenant-b' };
const KEY_OTHER: PKey = { poller: 'invoices', partition: '' };

type StatePatch = Partial<Omit<PollerState, 'createdAt'>>;

function zeroState(now: number): PollerState {
  return {
    lanes: {},
    schedule: {
      nextDueAt: null,
      intervalMs: null,
      consecutiveFailures: 0,
      circuit: 'closed',
      circuitOpenedAt: null,
      throttledUntil: null,
      rateLimit: null,
      lastPollAt: null,
      lastPoll: null,
      lastError: null,
    },
    paused: false,
    schemaVersion: null,
    sequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function mkState(over: Partial<PollerState> = {}): PollerState {
  return {
    lanes: {
      live: { cursor: JSON.stringify({ since: T0, ids: ['a', 'b'] }) },
      backfill: { cursor: 'page-3', target: 'page-9', done: false, force: true },
      reconcile: { cursor: null, done: true, lastRunAt: T0 + 5 },
    },
    schedule: {
      nextDueAt: T0 + 60_000,
      intervalMs: 60_000,
      consecutiveFailures: 2,
      circuit: 'half-open',
      circuitOpenedAt: T0 + 1,
      throttledUntil: T0 + 2,
      rateLimit: { limit: 100, remaining: 42, resetAt: T0 + 3, policy: '100;w=60', source: 'ietf' },
      lastPollAt: T0 + 4,
      lastPoll: {
        lane: 'live',
        startedAt: T0,
        durationMs: 120,
        pages: 2,
        items: 30,
        events: { created: 1, updated: 2, deleted: 3 },
        notModified: false,
        truncated: true,
      },
      lastError: {
        name: 'HttpError',
        message: 'GET /orders responded 503',
        code: 'HTTP',
        status: 503,
        cause: { name: 'Error', message: 'upstream unavailable' },
      },
    },
    paused: false,
    schemaVersion: 3,
    sequence: 17,
    createdAt: T0,
    updatedAt: T0 + 10,
    ...over,
  };
}

function patchOf(state: PollerState): StatePatch {
  const { createdAt: _createdAt, ...patch } = state;
  return patch;
}

function mkEvent(
  id: string,
  sequence: number,
  over: Partial<WatukuyEvent<unknown>> = {},
): WatukuyEvent<unknown> {
  return {
    id,
    type: 'created',
    source: 'urn:watukuy:orders',
    subject: `item-${sequence}`,
    time: new Date(T0 + sequence).toISOString(),
    poller: 'orders',
    partition: '',
    lane: 'live',
    sequence,
    cursor: { since: T0, page: sequence },
    data: {
      id: `item-${sequence}`,
      amount: sequence * 1.5,
      tags: ['a', 'b'],
      nested: { ok: true },
    },
    attempt: 1,
    ...over,
  };
}

function mkOutboxRow(id: string, sequence: number, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    eventId: id,
    sequence,
    event: mkEvent(id, sequence),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: T0 + sequence,
    ...over,
  };
}

function mkItem(identity: string, over: Partial<ItemRow> = {}): ItemRow {
  return {
    identity,
    version: 'v1',
    hash: `hash-${identity}`,
    schemaVersion: 1,
    seenAt: T0,
    ...over,
  };
}

function mkParked(id: string, over: Partial<ParkedRow> = {}): ParkedRow {
  return {
    id,
    kind: 'poison',
    event: mkEvent(id, 1),
    item: null,
    error: {
      name: 'HandlerError',
      message: `handler failed for ${id}`,
      code: 'HANDLER',
      history: [{ at: T0, message: 'first attempt' }],
    },
    attempts: 3,
    parkedAt: T0 + 100,
    holdKey: null,
    ...over,
  };
}

function mkBatch(over: Partial<CommitBatch> = {}): CommitBatch {
  return {
    statePatch: { updatedAt: T0 },
    upserts: [],
    deletes: [],
    events: [],
    log: false,
    ...over,
  };
}

const keyId = (k: PKey): string => JSON.stringify([k.poller, k.partition]);
const sortKeys = (keys: PKey[]): PKey[] =>
  keys
    .map((k) => ({ poller: k.poller, partition: k.partition }))
    .sort((a, b) => keyId(a).localeCompare(keyId(b)));
const seqs = (rows: ReadonlyArray<{ sequence: number }>): number[] => rows.map((r) => r.sequence);
const ids = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);
const eventIds = (rows: ReadonlyArray<OutboxRow>): string[] => rows.map((r) => r.eventId);

/**
 * Shared conformance suite for `StateStore` implementations (PLAN §9.2). Call it inside a test
 * file; every test receives a fresh store from `create()` and tears it down with `destroy()`
 * (or `close()`). Third-party stores certify themselves with it.
 *
 * @example
 * import { storeContractSuite } from 'watukuy/testing';
 * import { MyStore } from './my-store.ts';
 *
 * storeContractSuite({ name: 'MyStore', create: () => new MyStore() });
 */
export function storeContractSuite(opts: StoreContractOptions): void {
  describe(`store contract: ${opts.name}`, () => {
    let store: StateStore;

    beforeEach(async () => {
      store = await opts.create();
      await store.migrate();
    });

    afterEach(async () => {
      if (opts.destroy) await opts.destroy(store);
      else await store.close();
    });

    const acquire = async (key = KEY, owner = 'node-a', now = T0): Promise<Lease> => {
      const lease = await store.acquireLease(key, owner, TTL, now);
      if (!lease) throw new Error(`expected to acquire ${key.poller}/${key.partition} as ${owner}`);
      return lease;
    };

    describe('setup', () => {
      it('exposes a capabilities object', () => {
        expect(typeof store.capabilities.transactions).toBe('boolean');
        expect(typeof store.capabilities.log).toBe('boolean');
        expect(typeof store.capabilities.streaming).toBe('boolean');
      });

      it('migrate() is idempotent', async () => {
        await store.migrate();
        await store.migrate();
        expect(await store.loadState(KEY)).toBeNull();
        expect(await store.countItems(KEY)).toBe(0);
      });
    });

    describe('leases', () => {
      it('acquire on an empty key returns epoch 1', async () => {
        const lease = await store.acquireLease(KEY, 'node-a', TTL, T0);
        expect(lease).toEqual({ owner: 'node-a', epoch: 1, expiresAt: T0 + TTL });
      });

      it('another owner cannot acquire while the lease is valid', async () => {
        await acquire();
        expect(await store.acquireLease(KEY, 'node-b', TTL, T0 + 1_000)).toBeNull();
        expect(await store.acquireLease(KEY, 'node-b', TTL, T0 + TTL - 1)).toBeNull();
        expect(await store.getLease(KEY)).toEqual({
          owner: 'node-a',
          epoch: 1,
          expiresAt: T0 + TTL,
        });
      });

      it('the same owner re-acquiring bumps the epoch', async () => {
        const first = await acquire();
        const second = await store.acquireLease(KEY, 'node-a', TTL, T0 + 5);
        expect(second).toEqual({ owner: 'node-a', epoch: 2, expiresAt: T0 + 5 + TTL });
        expect(await store.renewLease(KEY, first, TTL, T0 + 6)).toBe(false);
        expect(await store.getLease(KEY)).toEqual(second);
      });

      it('an expired lease is stolen with epoch + 1', async () => {
        await acquire();
        const stolen = await store.acquireLease(KEY, 'node-b', TTL, T0 + TTL);
        expect(stolen).toEqual({ owner: 'node-b', epoch: 2, expiresAt: T0 + TTL + TTL });
        expect(await store.getLease(KEY)).toEqual(stolen);
      });

      it('renew succeeds for the current epoch and fails for a stale one', async () => {
        const lease = await acquire();
        expect(await store.renewLease(KEY, lease, TTL, T0 + 10_000)).toBe(true);
        expect(await store.getLease(KEY)).toEqual({ ...lease, expiresAt: T0 + 10_000 + TTL });
        expect(await store.renewLease(KEY, { ...lease, epoch: 2 }, TTL, T0 + 11_000)).toBe(false);
        expect(await store.renewLease(KEY, { ...lease, owner: 'node-b' }, TTL, T0 + 11_000)).toBe(
          false,
        );
        expect(await store.renewLease(KEY_B, lease, TTL, T0 + 11_000)).toBe(false);
        expect(await store.getLease(KEY)).toEqual({ ...lease, expiresAt: T0 + 10_000 + TTL });
      });

      it('release then acquire works and the epoch stays monotonic', async () => {
        const lease = await acquire();
        await store.releaseLease(KEY, lease);
        expect(await store.getLease(KEY)).toBeNull();
        const next = await store.acquireLease(KEY, 'node-b', TTL, T0 + 1);
        expect(next).toEqual({ owner: 'node-b', epoch: 2, expiresAt: T0 + 1 + TTL });
      });

      it('release with a stale lease is a no-op', async () => {
        const lease = await acquire();
        await store.releaseLease(KEY, { ...lease, epoch: 99 });
        await store.releaseLease(KEY, { ...lease, owner: 'node-z' });
        await store.releaseLease(KEY_B, lease);
        expect(await store.getLease(KEY)).toEqual(lease);
      });

      it('getLease is null before any acquisition and the holder afterwards', async () => {
        expect(await store.getLease(KEY)).toBeNull();
        const lease = await acquire();
        expect(await store.getLease(KEY)).toEqual(lease);
      });
    });

    describe('fencing', () => {
      const seed = async (): Promise<Lease> => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('i1')],
            events: [mkOutboxRow('e1', 1)],
            statePatch: { sequence: 1, updatedAt: T0 },
          }),
        );
        return lease;
      };

      const cases: Array<{
        method: string;
        run: (lease: Lease) => Promise<unknown>;
        verify: () => Promise<void>;
      }> = [
        {
          method: 'saveState',
          run: (l) => store.saveState(KEY, l, { paused: true, updatedAt: T0 + 9 }),
          verify: async () => {
            const state = await store.loadState(KEY);
            expect(state?.paused).toBe(false);
            expect(state?.updatedAt).toBe(T0);
          },
        },
        {
          method: 'commitPoll',
          run: (l) =>
            store.commitPoll(
              KEY,
              l,
              mkBatch({
                upserts: [mkItem('i2')],
                deletes: ['i1'],
                events: [mkOutboxRow('e2', 2)],
                parked: [mkParked('p1', { holdKey: 'held' })],
                statePatch: { sequence: 2, updatedAt: T0 + 9 },
                log: true,
              }),
            ),
          verify: async () => {
            expect([...(await store.loadVersions(KEY, ['i1', 'i2'])).keys()]).toEqual(['i1']);
            expect(await store.countItems(KEY)).toBe(1);
            expect(eventIds(await store.loadPending(KEY, 10))).toEqual(['e1']);
            expect(await store.countParked(KEY)).toBe(0);
            expect(await store.heldKeys(KEY)).toEqual(new Set());
            expect((await store.loadState(KEY))?.sequence).toBe(1);
            if (store.capabilities.log) expect(await store.readLog(KEY, {}, 10)).toEqual([]);
          },
        },
        {
          method: 'ackEvents',
          run: (l) => store.ackEvents(KEY, l, ['e1']),
          verify: async () => {
            expect(eventIds(await store.loadPending(KEY, 10))).toEqual(['e1']);
          },
        },
        {
          method: 'recordAttempt',
          run: (l) =>
            store.recordAttempt(KEY, l, 'e1', { name: 'Error', message: 'boom' }, T0 + 1_000),
          verify: async () => {
            const [row] = await store.loadPending(KEY, 10);
            expect(row?.attempts).toBe(0);
            expect(row?.lastError).toBeNull();
            expect(row?.nextAttemptAt).toBeNull();
          },
        },
        {
          method: 'parkEvent',
          run: (l) => store.parkEvent(KEY, l, mkParked('p1', { event: mkEvent('e1', 1) })),
          verify: async () => {
            expect(await store.countParked(KEY)).toBe(0);
            expect(eventIds(await store.loadPending(KEY, 10))).toEqual(['e1']);
          },
        },
        {
          method: 'setValidator',
          run: (l) =>
            store.setValidator(KEY, l, 'url-1', { etag: '"a"', lastModified: null, storedAt: T0 }),
          verify: async () => {
            expect(await store.getValidator(KEY, 'url-1')).toBeNull();
          },
        },
      ];

      for (const c of cases) {
        it(`${c.method} with a stale lease throws LeaseLostError and changes nothing`, async () => {
          const stale = await seed();
          const current = await store.acquireLease(KEY, 'node-b', TTL, T0 + TTL);
          expect(current).not.toBeNull();
          await expect(c.run(stale)).rejects.toBeInstanceOf(LeaseLostError);
          await expect(c.run({ ...current!, owner: 'node-a' })).rejects.toBeInstanceOf(
            LeaseLostError,
          );
          await expect(c.run({ ...current!, epoch: current!.epoch + 1 })).rejects.toBeInstanceOf(
            LeaseLostError,
          );
          await c.verify();
          expect(await store.getLease(KEY)).toEqual(current);
        });
      }

      it('fenced writes without any lease throw LeaseLostError', async () => {
        const ghost: Lease = { owner: 'ghost', epoch: 1, expiresAt: T0 + TTL };
        await expect(store.saveState(KEY, ghost, { paused: true })).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        await expect(store.commitPoll(KEY, ghost, mkBatch())).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        expect(await store.loadState(KEY)).toBeNull();
        expect(await store.getLease(KEY)).toBeNull();
      });

      it('a released lease no longer passes the fence', async () => {
        const lease = await seed();
        await store.releaseLease(KEY, lease);
        await expect(store.saveState(KEY, lease, { paused: true })).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        expect((await store.loadState(KEY))?.paused).toBe(false);
      });

      it('LeaseLostError carries the key and the rejected epoch', async () => {
        const stale = await seed();
        await store.acquireLease(KEY, 'node-b', TTL, T0 + TTL);
        const err = await store.saveState(KEY, stale, { paused: true }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(LeaseLostError);
        const lost = err as LeaseLostError;
        expect(lost.code).toBe('LEASE_LOST');
        expect(lost.poller).toBe(KEY.poller);
        expect(lost.partition).toBe(KEY.partition);
        expect(lost.epoch).toBe(stale.epoch);
      });
    });

    describe('state', () => {
      it('loadState is null for an unknown key', async () => {
        expect(await store.loadState(KEY)).toBeNull();
        await acquire();
        expect(await store.loadState(KEY)).toBeNull();
      });

      it('saveState then loadState round-trips every field including nested JSON', async () => {
        const lease = await acquire();
        const state = mkState();
        await store.saveState(KEY, lease, patchOf(state));
        expect(await store.loadState(KEY)).toEqual({ ...state, createdAt: state.updatedAt });
      });

      it('saveStateUnfenced creates a zero state with createdAt from patch.updatedAt', async () => {
        await store.saveStateUnfenced(KEY, { paused: true, updatedAt: T0 + 5 });
        expect(await store.loadState(KEY)).toEqual({ ...zeroState(T0 + 5), paused: true });
        expect(await store.getLease(KEY)).toBeNull();
      });

      it('saveStateUnfenced without updatedAt uses createdAt 0', async () => {
        await store.saveStateUnfenced(KEY, { paused: true });
        expect(await store.loadState(KEY)).toEqual({ ...zeroState(0), paused: true });
      });

      it('patches replace top-level fields and preserve createdAt', async () => {
        const lease = await acquire();
        const state = mkState();
        await store.saveState(KEY, lease, patchOf(state));
        await store.saveState(KEY, lease, {
          lanes: { live: { cursor: 'c2' } },
          sequence: 18,
          updatedAt: T0 + 20,
        });
        const loaded = await store.loadState(KEY);
        expect(loaded).toEqual({
          ...state,
          lanes: { live: { cursor: 'c2' } },
          sequence: 18,
          updatedAt: T0 + 20,
          createdAt: state.updatedAt,
        });
        expect(loaded?.lanes.backfill).toBeUndefined();
        expect(loaded?.schedule).toEqual(state.schedule);
        await store.saveStateUnfenced(KEY, { paused: true, updatedAt: T0 + 30 });
        const paused = await store.loadState(KEY);
        expect(paused?.paused).toBe(true);
        expect(paused?.createdAt).toBe(state.updatedAt);
        expect(paused?.sequence).toBe(18);
      });

      it('listKeys lists known keys, optionally filtered by poller', async () => {
        expect(await store.listKeys()).toEqual([]);
        await acquire(KEY);
        await store.saveStateUnfenced(KEY_B, { updatedAt: T0 });
        await acquire(KEY_OTHER, 'node-x');
        expect(sortKeys(await store.listKeys())).toEqual(sortKeys([KEY, KEY_B, KEY_OTHER]));
        expect(sortKeys(await store.listKeys('orders'))).toEqual(sortKeys([KEY, KEY_B]));
        expect(await store.listKeys('unknown')).toEqual([]);
      });

      it('deleteKey removes state, lease, items, outbox, parked, validators and log', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('i1')],
            events: [mkOutboxRow('e1', 1)],
            parked: [mkParked('p1', { holdKey: 'held' })],
            statePatch: { sequence: 1, updatedAt: T0 },
            log: true,
          }),
        );
        await store.setValidator(KEY, lease, 'url-1', {
          etag: '"a"',
          lastModified: null,
          storedAt: T0,
        });
        const leaseB = await acquire(KEY_B, 'node-b');
        await store.commitPoll(KEY_B, leaseB, mkBatch({ upserts: [mkItem('j1')] }));

        await store.deleteKey(KEY);

        expect(await store.loadState(KEY)).toBeNull();
        expect(await store.getLease(KEY)).toBeNull();
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.loadVersions(KEY, ['i1'])).toEqual(new Map());
        expect(await store.countPending(KEY)).toBe(0);
        expect(await store.loadPending(KEY, 10)).toEqual([]);
        expect(await store.countParked(KEY)).toBe(0);
        expect(await store.heldKeys(KEY)).toEqual(new Set());
        expect(await store.getValidator(KEY, 'url-1')).toBeNull();
        if (store.capabilities.log) expect(await store.readLog(KEY, {}, 10)).toEqual([]);
        expect((await store.listKeys()).some((k) => keyId(k) === keyId(KEY))).toBe(false);
        expect(await store.countItems(KEY_B)).toBe(1);
        expect(await store.getLease(KEY_B)).toEqual(leaseB);
        await store.deleteKey(KEY);
      });

      it('clearItems drops the item snapshot only', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('i1'), mkItem('i2')],
            events: [mkOutboxRow('e1', 1)],
            parked: [mkParked('p1')],
            statePatch: { sequence: 1, updatedAt: T0 },
          }),
        );
        await store.clearItems(KEY);
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.countPending(KEY)).toBe(1);
        expect(await store.countParked(KEY)).toBe(1);
        expect((await store.loadState(KEY))?.sequence).toBe(1);
        expect(await store.getLease(KEY)).toEqual(lease);
        await store.clearItems(KEY_B);
      });
    });

    describe('items', () => {
      it('loadVersions returns only present rows, with payload only when stored', async () => {
        const lease = await acquire();
        const payload = { name: 'B', tags: ['x', 'y'], nested: { n: 1.5, ok: true, none: null } };
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [
              mkItem('a'),
              mkItem('b', { payload, version: null, schemaVersion: 2, seenAt: T0 + 1 }),
              mkItem('c', { payload: null }),
            ],
          }),
        );
        const rows = await store.loadVersions(KEY, ['a', 'b', 'c', 'missing']);
        expect([...rows.keys()].sort()).toEqual(['a', 'b', 'c']);
        expect(rows.get('a')).toEqual(mkItem('a'));
        expect('payload' in rows.get('a')!).toBe(false);
        expect(rows.get('b')).toEqual(
          mkItem('b', { payload, version: null, schemaVersion: 2, seenAt: T0 + 1 }),
        );
        expect(rows.get('c')).toEqual(mkItem('c', { payload: null }));
        expect('payload' in rows.get('c')!).toBe(true);
        expect(rows.get('c')?.payload).toBeNull();
        expect(await store.loadVersions(KEY, [])).toEqual(new Map());
        expect(await store.loadVersions(KEY_B, ['a'])).toEqual(new Map());
      });

      it('upserts replace existing rows and deletes remove them', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ upserts: [mkItem('a'), mkItem('b', { payload: { v: 1 } })] }),
        );
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('a', { hash: 'hash-a2', version: 'v2', seenAt: T0 + 5 }), mkItem('c')],
            deletes: ['b', 'never-existed'],
          }),
        );
        const rows = await store.loadVersions(KEY, ['a', 'b', 'c']);
        expect([...rows.keys()].sort()).toEqual(['a', 'c']);
        expect(rows.get('a')).toEqual(
          mkItem('a', { hash: 'hash-a2', version: 'v2', seenAt: T0 + 5 }),
        );
        expect(await store.countItems(KEY)).toBe(2);
      });

      it('streamIdentities yields every identity in batches of batchSize', async () => {
        const lease = await acquire();
        const all = Array.from({ length: 2500 }, (_, i) => `id-${String(i).padStart(5, '0')}`);
        await store.commitPoll(KEY, lease, mkBatch({ upserts: all.map((id) => mkItem(id)) }));

        const batches: string[][] = [];
        for await (const batch of store.streamIdentities(KEY, 1000)) batches.push(batch);
        expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
        expect(batches.flat().sort()).toEqual(all);

        const byDefault: string[] = [];
        for await (const batch of store.streamIdentities(KEY)) byDefault.push(...batch);
        expect(byDefault.length).toBe(2500);
        expect(new Set(byDefault).size).toBe(2500);

        const none: string[][] = [];
        for await (const batch of store.streamIdentities(KEY_B, 1000)) none.push(batch);
        expect(none.flat()).toEqual([]);
      });

      it('countItems counts the snapshot', async () => {
        expect(await store.countItems(KEY)).toBe(0);
        const lease = await acquire();
        await store.commitPoll(KEY, lease, mkBatch({ upserts: [mkItem('a'), mkItem('b')] }));
        expect(await store.countItems(KEY)).toBe(2);
        await store.commitPoll(KEY, lease, mkBatch({ upserts: [mkItem('a')], deletes: ['b'] }));
        expect(await store.countItems(KEY)).toBe(1);
      });
    });

    describe('commitPoll', () => {
      it('applies upserts, deletes, events, parked rows and the state patch together', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('a'), mkItem('b')],
            statePatch: { sequence: 0, updatedAt: T0 },
          }),
        );
        const invalid = mkParked('inv-1', {
          kind: 'invalid',
          event: null,
          item: { raw: true, id: 7 },
          error: {
            name: 'ValidationError',
            message: 'bad item',
            code: 'VALIDATION',
            issues: [{ message: 'required', path: ['id'] }],
          },
          attempts: 0,
        });
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('c'), mkItem('a', { hash: 'hash-a2', version: 'v2' })],
            deletes: ['b'],
            events: [mkOutboxRow('e1', 1), mkOutboxRow('e2', 2)],
            parked: [invalid],
            statePatch: {
              sequence: 2,
              lanes: { live: { cursor: 'c2' } },
              schemaVersion: 1,
              updatedAt: T0 + 1,
            },
          }),
        );
        const rows = await store.loadVersions(KEY, ['a', 'b', 'c']);
        expect([...rows.keys()].sort()).toEqual(['a', 'c']);
        expect(rows.get('a')?.hash).toBe('hash-a2');
        expect(await store.loadPending(KEY, 10)).toEqual([
          mkOutboxRow('e1', 1),
          mkOutboxRow('e2', 2),
        ]);
        expect(await store.listParked(KEY)).toEqual([invalid]);
        expect(await store.loadState(KEY)).toEqual({
          ...zeroState(T0),
          sequence: 2,
          lanes: { live: { cursor: 'c2' } },
          schemaVersion: 1,
          updatedAt: T0 + 1,
        });
      });

      it('appends to the log only when batch.log is true', async (ctx) => {
        if (!store.capabilities.log) return ctx.skip();
        const lease = await acquire();
        await store.commitPoll(KEY, lease, mkBatch({ events: [mkOutboxRow('e1', 1)], log: false }));
        expect(await store.readLog(KEY, {}, 10)).toEqual([]);
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ events: [mkOutboxRow('e2', 2), mkOutboxRow('e3', 3)], log: true }),
        );
        expect(await store.readLog(KEY, {}, 10)).toEqual([
          { sequence: 2, event: mkEvent('e2', 2), createdAt: T0 + 2 },
          { sequence: 3, event: mkEvent('e3', 3), createdAt: T0 + 3 },
        ]);
      });

      it('re-committing an existing event id overwrites the outbox row', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, mkBatch({ events: [mkOutboxRow('e1', 1)] }));
        await store.recordAttempt(KEY, lease, 'e1', { name: 'Error', message: 'fail' }, T0 + 500);
        expect((await store.loadPending(KEY, 10))[0]?.attempts).toBe(1);

        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ events: [mkOutboxRow('e1', 1, { createdAt: T0 + 50 })] }),
        );
        expect(await store.loadPending(KEY, 10)).toEqual([
          mkOutboxRow('e1', 1, { createdAt: T0 + 50 }),
        ]);
        expect(await store.countPending(KEY)).toBe(1);

        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ events: [mkOutboxRow('e1', 1, { status: 'delivered' })] }),
        );
        expect(await store.countPending(KEY)).toBe(0);
        await store.commitPoll(KEY, lease, mkBatch({ events: [mkOutboxRow('e1', 1)] }));
        expect(await store.loadPending(KEY, 10)).toEqual([mkOutboxRow('e1', 1)]);
      });

      it('an empty batch still applies the state patch', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ statePatch: { sequence: 5, updatedAt: T0 + 3 } }),
        );
        expect(await store.loadState(KEY)).toEqual({ ...zeroState(T0 + 3), sequence: 5 });
        expect(await store.countItems(KEY)).toBe(0);
        expect(await store.countPending(KEY)).toBe(0);
      });
    });

    describe('outbox', () => {
      it('loadPending orders by sequence, honours limit and ignores nextAttemptAt', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            events: [
              mkOutboxRow('e3', 3, { nextAttemptAt: T0 + 999_999_999 }),
              mkOutboxRow('e1', 1),
              mkOutboxRow('e2', 2, { attempts: 4, lastError: { name: 'Error', message: 'x' } }),
            ],
          }),
        );
        const all = await store.loadPending(KEY, 10);
        expect(eventIds(all)).toEqual(['e1', 'e2', 'e3']);
        expect(all[2]?.nextAttemptAt).toBe(T0 + 999_999_999);
        expect(all[1]).toEqual(
          mkOutboxRow('e2', 2, { attempts: 4, lastError: { name: 'Error', message: 'x' } }),
        );
        expect(eventIds(await store.loadPending(KEY, 2))).toEqual(['e1', 'e2']);
        expect(await store.loadPending(KEY, 0)).toEqual([]);
        expect(await store.loadPending(KEY_B, 10)).toEqual([]);
      });

      it('countPending counts pending rows only', async () => {
        const lease = await acquire();
        expect(await store.countPending(KEY)).toBe(0);
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            events: [
              mkOutboxRow('e1', 1),
              mkOutboxRow('e2', 2),
              mkOutboxRow('e3', 3, { status: 'delivered' }),
            ],
          }),
        );
        expect(await store.countPending(KEY)).toBe(2);
        await store.ackEvents(KEY, lease, ['e1']);
        expect(await store.countPending(KEY)).toBe(1);
      });

      it('ackEvents removes rows and ignores unknown ids', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ events: [mkOutboxRow('e1', 1), mkOutboxRow('e2', 2), mkOutboxRow('e3', 3)] }),
        );
        await store.ackEvents(KEY, lease, ['e1', 'e3', 'unknown']);
        expect(eventIds(await store.loadPending(KEY, 10))).toEqual(['e2']);
        await store.ackEvents(KEY, lease, []);
        expect(await store.countPending(KEY)).toBe(1);
      });

      it('recordAttempt increments attempts and records the error and next attempt', async () => {
        const lease = await acquire();
        await store.commitPoll(KEY, lease, mkBatch({ events: [mkOutboxRow('e1', 1)] }));
        const err = {
          name: 'HandlerError',
          message: 'boom',
          code: 'HANDLER',
          cause: { name: 'TypeError', message: 'x is not a function' },
        };
        await store.recordAttempt(KEY, lease, 'e1', err, T0 + 5_000);
        expect((await store.loadPending(KEY, 10))[0]).toEqual(
          mkOutboxRow('e1', 1, { attempts: 1, lastError: err, nextAttemptAt: T0 + 5_000 }),
        );
        await store.recordAttempt(KEY, lease, 'e1', { name: 'Error', message: 'again' }, null);
        expect((await store.loadPending(KEY, 10))[0]).toEqual(
          mkOutboxRow('e1', 1, {
            attempts: 2,
            lastError: { name: 'Error', message: 'again' },
            nextAttemptAt: null,
          }),
        );
        await store.recordAttempt(KEY, lease, 'unknown', err, T0);
        expect(await store.countPending(KEY)).toBe(1);
      });
    });

    describe('parked', () => {
      it('parkEvent removes the outbox row and heldKeys reflects holdKey', async () => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({ events: [mkOutboxRow('e1', 1), mkOutboxRow('e2', 2)] }),
        );
        const poison = mkParked('p1', {
          event: mkEvent('e1', 1),
          holdKey: 'item-1',
          error: {
            name: 'HandlerError',
            message: 'boom',
            code: 'HANDLER',
            history: [
              { at: T0, message: 'first' },
              { at: T0 + 1, message: 'second' },
            ],
          },
        });
        await store.parkEvent(KEY, lease, poison);
        expect(eventIds(await store.loadPending(KEY, 10))).toEqual(['e2']);
        expect(await store.listParked(KEY)).toEqual([poison]);
        expect(await store.heldKeys(KEY)).toEqual(new Set(['item-1']));

        const invalid = mkParked('p2', {
          kind: 'invalid',
          event: null,
          item: { id: 'raw', values: [1, 2, 3] },
          holdKey: null,
          parkedAt: T0 + 200,
        });
        await store.parkEvent(KEY, lease, invalid);
        expect(await store.countPending(KEY)).toBe(1);
        expect(await store.heldKeys(KEY)).toEqual(new Set(['item-1']));
        expect(await store.countParked(KEY)).toBe(2);
        expect(await store.listParked(KEY, { kind: 'invalid' })).toEqual([invalid]);
      });

      it('listParked filters by kind, orders by parkedAt and honours limit', async () => {
        const lease = await acquire();
        const rows = [
          mkParked('p3', { parkedAt: T0 + 30 }),
          mkParked('p1', { parkedAt: T0 + 10, kind: 'invalid', event: null, item: { n: 1 } }),
          mkParked('p2', { parkedAt: T0 + 20 }),
        ];
        for (const row of rows) await store.parkEvent(KEY, lease, row);
        expect(ids(await store.listParked(KEY))).toEqual(['p1', 'p2', 'p3']);
        expect(ids(await store.listParked(KEY, { kind: 'poison' }))).toEqual(['p2', 'p3']);
        expect(ids(await store.listParked(KEY, { kind: 'invalid' }))).toEqual(['p1']);
        expect(ids(await store.listParked(KEY, { limit: 2 }))).toEqual(['p1', 'p2']);
        expect(ids(await store.listParked(KEY, { kind: 'poison', limit: 1 }))).toEqual(['p2']);
        expect(await store.listParked(KEY_B)).toEqual([]);
      });

      it('countParked counts every kind', async () => {
        const lease = await acquire();
        expect(await store.countParked(KEY)).toBe(0);
        await store.parkEvent(KEY, lease, mkParked('p1'));
        await store.parkEvent(
          KEY,
          lease,
          mkParked('p2', { kind: 'invalid', event: null, item: 1 }),
        );
        expect(await store.countParked(KEY)).toBe(2);
        await store.parkEvent(KEY, lease, mkParked('p1', { attempts: 9 }));
        expect(await store.countParked(KEY)).toBe(2);
        expect((await store.listParked(KEY, { kind: 'poison' }))[0]?.attempts).toBe(9);
      });

      it('retryParked moves poison rows back to the outbox and returns the count', async () => {
        const lease = await acquire();
        const poison = mkParked('p1', {
          event: mkEvent('e1', 7),
          parkedAt: T0 + 100,
          holdKey: 'k1',
        });
        const invalid = mkParked('p2', { kind: 'invalid', event: null, item: { n: 1 } });
        await store.parkEvent(KEY, lease, poison);
        await store.parkEvent(KEY, lease, invalid);

        expect(await store.retryParked(KEY, ['p1', 'p2', 'unknown'])).toBe(1);
        expect(await store.loadPending(KEY, 10)).toEqual([
          {
            eventId: 'e1',
            sequence: 7,
            event: mkEvent('e1', 7),
            status: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            createdAt: T0 + 100,
          },
        ]);
        expect(ids(await store.listParked(KEY))).toEqual(['p2']);
        expect(await store.heldKeys(KEY)).toEqual(new Set());
        expect(await store.retryParked(KEY, ['p1'])).toBe(0);
        expect(await store.retryParked(KEY, [])).toBe(0);
      });

      it('discardParked removes rows and returns the count', async () => {
        const lease = await acquire();
        await store.parkEvent(KEY, lease, mkParked('p1'));
        await store.parkEvent(KEY, lease, mkParked('p2', { holdKey: 'k2' }));
        expect(await store.discardParked(KEY, ['p1', 'unknown'])).toBe(1);
        expect(ids(await store.listParked(KEY))).toEqual(['p2']);
        expect(await store.heldKeys(KEY)).toEqual(new Set(['k2']));
        expect(await store.discardParked(KEY, ['p2', 'p2'])).toBe(1);
        expect(await store.countParked(KEY)).toBe(0);
        expect(await store.heldKeys(KEY)).toEqual(new Set());
        expect(await store.discardParked(KEY, [])).toBe(0);
      });
    });

    describe('validators', () => {
      it('getValidator is null until set; setValidator round-trips and overwrites', async () => {
        const lease = await acquire();
        expect(await store.getValidator(KEY, 'url-1')).toBeNull();
        const v1 = { etag: '"abc"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT', storedAt: T0 };
        await store.setValidator(KEY, lease, 'url-1', v1);
        expect(await store.getValidator(KEY, 'url-1')).toEqual(v1);
        const v2 = { etag: null, lastModified: null, storedAt: T0 + 1 };
        await store.setValidator(KEY, lease, 'url-1', v2);
        expect(await store.getValidator(KEY, 'url-1')).toEqual(v2);
        await store.setValidator(KEY, lease, 'url-2', v1);
        expect(await store.getValidator(KEY, 'url-2')).toEqual(v1);
        expect(await store.getValidator(KEY, 'url-3')).toBeNull();
      });
    });

    describe('log', () => {
      const seedLog = async (): Promise<void> => {
        const lease = await acquire();
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            events: [1, 2, 3, 4, 5].map((n) =>
              mkOutboxRow(`e${n}`, n, { createdAt: T0 + n * 1_000 }),
            ),
            log: true,
          }),
        );
      };

      it('readLog filters by afterSequence and orders by sequence', async (ctx) => {
        if (!store.capabilities.log) return ctx.skip();
        await seedLog();
        expect(seqs(await store.readLog(KEY, {}, 10))).toEqual([1, 2, 3, 4, 5]);
        expect(seqs(await store.readLog(KEY, { afterSequence: 3 }, 10))).toEqual([4, 5]);
        expect(await store.readLog(KEY, { afterSequence: 5 }, 10)).toEqual([]);
        expect((await store.readLog(KEY, {}, 10))[0]).toEqual({
          sequence: 1,
          event: mkEvent('e1', 1),
          createdAt: T0 + 1_000,
        });
        expect(await store.readLog(KEY_B, {}, 10)).toEqual([]);
      });

      it('readLog filters by fromTime/toTime (inclusive) and honours limit', async (ctx) => {
        if (!store.capabilities.log) return ctx.skip();
        await seedLog();
        expect(seqs(await store.readLog(KEY, { fromTime: T0 + 2_000 }, 10))).toEqual([2, 3, 4, 5]);
        expect(seqs(await store.readLog(KEY, { toTime: T0 + 3_000 }, 10))).toEqual([1, 2, 3]);
        expect(
          seqs(await store.readLog(KEY, { fromTime: T0 + 2_000, toTime: T0 + 4_000 }, 10)),
        ).toEqual([2, 3, 4]);
        expect(seqs(await store.readLog(KEY, {}, 2))).toEqual([1, 2]);
        expect(
          seqs(
            await store.readLog(
              KEY,
              { afterSequence: 1, fromTime: T0 + 2_000, toTime: T0 + 4_000 },
              2,
            ),
          ),
        ).toEqual([2, 3]);
        expect(await store.readLog(KEY, {}, 0)).toEqual([]);
      });

      it('pruneLog removes entries older than the cutoff and returns the count', async (ctx) => {
        if (!store.capabilities.log) return ctx.skip();
        await seedLog();
        expect(await store.pruneLog(KEY, T0 + 3_000)).toBe(2);
        expect(seqs(await store.readLog(KEY, {}, 10))).toEqual([3, 4, 5]);
        expect(await store.pruneLog(KEY, T0 + 3_000)).toBe(0);
        expect(await store.pruneLog(KEY_B, T0 + 999_999)).toBe(0);
        expect(await store.pruneLog(KEY, T0 + 999_999)).toBe(3);
        expect(await store.readLog(KEY, {}, 10)).toEqual([]);
      });
    });

    describe('isolation', () => {
      const seedA = async (): Promise<Lease> => {
        const lease = await acquire(KEY, 'node-a');
        await store.commitPoll(
          KEY,
          lease,
          mkBatch({
            upserts: [mkItem('a')],
            events: [mkOutboxRow('e1', 1)],
            parked: [mkParked('p1', { holdKey: 'held' })],
            statePatch: { sequence: 1, updatedAt: T0 },
            log: true,
          }),
        );
        await store.setValidator(KEY, lease, 'url-1', {
          etag: '"a"',
          lastModified: null,
          storedAt: T0,
        });
        return lease;
      };

      const expectEmpty = async (key: PKey): Promise<void> => {
        expect(await store.countItems(key)).toBe(0);
        expect(await store.loadVersions(key, ['a'])).toEqual(new Map());
        expect(await store.countPending(key)).toBe(0);
        expect(await store.loadPending(key, 10)).toEqual([]);
        expect(await store.countParked(key)).toBe(0);
        expect(await store.listParked(key)).toEqual([]);
        expect(await store.heldKeys(key)).toEqual(new Set());
        expect(await store.loadState(key)).toBeNull();
        expect(await store.getValidator(key, 'url-1')).toBeNull();
        if (store.capabilities.log) expect(await store.readLog(key, {}, 10)).toEqual([]);
      };

      it('partitions of the same poller do not see each other', async () => {
        const leaseA = await seedA();
        const leaseB = await acquire(KEY_B, 'node-b');
        expect(leaseB.epoch).toBe(1);
        await expectEmpty(KEY_B);
        expect(await store.getLease(KEY_B)).toEqual(leaseB);

        await expect(store.saveState(KEY_B, leaseA, { paused: true })).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        await store.commitPoll(
          KEY_B,
          leaseB,
          mkBatch({ upserts: [mkItem('b1'), mkItem('b2')], deletes: ['a'] }),
        );
        await store.ackEvents(KEY_B, leaseB, ['e1']);
        expect(await store.discardParked(KEY_B, ['p1'])).toBe(0);
        expect(await store.countItems(KEY)).toBe(1);
        expect(await store.countPending(KEY)).toBe(1);
        expect(await store.countParked(KEY)).toBe(1);
        expect(await store.countItems(KEY_B)).toBe(2);

        await store.releaseLease(KEY_B, leaseB);
        expect(await store.getLease(KEY)).toEqual(leaseA);
        expect(await store.getLease(KEY_B)).toBeNull();
      });

      it('different pollers with the same partition do not see each other', async () => {
        const leaseA = await seedA();
        await expectEmpty(KEY_OTHER);
        const leaseOther = await acquire(KEY_OTHER, 'node-a');
        expect(leaseOther.epoch).toBe(1);
        await store.deleteKey(KEY_OTHER);
        expect(await store.countItems(KEY)).toBe(1);
        expect(await store.getLease(KEY)).toEqual(leaseA);
        expect(await store.getValidator(KEY, 'url-1')).not.toBeNull();
      });
    });
  });
}
