import { describe, expect, it } from 'vitest';
import { definePoller } from '../core/define-poller.ts';
import type { ResolvedPoller } from '../core/poller-types.ts';
import type { ItemRow } from '../core/store-types.ts';
import { detectDeletes, diffCandidates, prepareCandidates } from './diff.ts';
import { hashValue } from './hash.ts';

interface Item {
  id: string;
  name: string;
  updatedAt?: string;
}

function makePoller(
  overrides: {
    version?: (item: Item) => string | number;
    fingerprint?: (item: Item) => unknown;
    retain?: 'hash' | 'payload';
    schemaVersion?: number;
    onSchemaChange?: 'rebaseline' | 'emit';
  } = {},
): ResolvedPoller {
  return definePoller({
    name: 'items',
    identity: (i: Item) => i.id,
    cursor: { strategy: 'snapshotDiff' },
    fetch: async () => ({ items: [] as Item[] }),
    ...overrides,
  }).resolved;
}

async function row(
  poller: ResolvedPoller,
  item: Item,
  extra: Partial<ItemRow> = {},
): Promise<ItemRow> {
  return {
    identity: item.id,
    version: poller.version ? String(poller.version(item as never)) : null,
    hash: await hashValue(poller.fingerprint ? poller.fingerprint(item as never) : item),
    schemaVersion: poller.schemaVersion,
    seenAt: 1_000,
    ...extra,
  };
}

const NOW = 5_000;

describe('prepareCandidates', () => {
  it('computes identity, null version, and hash for every item', async () => {
    const poller = makePoller();
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const { candidates, unchanged } = await prepareCandidates(poller, items, new Map());
    expect(unchanged).toEqual([]);
    expect(candidates.map((c) => c.identity)).toEqual(['a', 'b']);
    expect(candidates[0]).toEqual({
      identity: 'a',
      item: items[0],
      version: null,
      hash: await hashValue(items[0]),
    });
  });

  it('stringifies version selectors', async () => {
    const poller = makePoller({ version: (i) => Number(i.updatedAt) });
    const { candidates } = await prepareCandidates(
      poller,
      [{ id: 'a', name: 'A', updatedAt: '42' }],
      new Map(),
    );
    expect(candidates[0]?.version).toBe('42');
  });

  it('skips hashing when version and schemaVersion match the stored row (fast path)', async () => {
    let fingerprintCalls = 0;
    const poller = makePoller({
      version: (i) => i.updatedAt ?? '',
      fingerprint: (i) => {
        fingerprintCalls++;
        return { name: i.name };
      },
    });
    const same: Item = { id: 'same', name: 'S', updatedAt: 'v1' };
    const bumped: Item = { id: 'bumped', name: 'B', updatedAt: 'v2' };
    const fresh: Item = { id: 'fresh', name: 'F', updatedAt: 'v1' };
    const existing = new Map<string, ItemRow>([
      ['same', await row(poller, same)],
      ['bumped', await row(poller, { ...bumped, updatedAt: 'v1' })],
    ]);
    fingerprintCalls = 0;

    const { candidates, unchanged } = await prepareCandidates(
      poller,
      [same, bumped, fresh],
      existing,
    );
    expect(unchanged).toEqual(['same']);
    expect(candidates.map((c) => c.identity)).toEqual(['bumped', 'fresh']);
    expect(fingerprintCalls).toBe(2);
  });

  it('does not take the fast path when the stored schemaVersion differs', async () => {
    let fingerprintCalls = 0;
    const poller = makePoller({
      version: () => 'v1',
      fingerprint: (i) => {
        fingerprintCalls++;
        return i.name;
      },
      schemaVersion: 2,
    });
    const item: Item = { id: 'a', name: 'A' };
    const existing = new Map([['a', await row(poller, item, { schemaVersion: 1 })]]);
    fingerprintCalls = 0;
    const { candidates, unchanged } = await prepareCandidates(poller, [item], existing);
    expect(unchanged).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(fingerprintCalls).toBe(1);
  });

  it('never takes the fast path without a version selector', async () => {
    const poller = makePoller();
    const item: Item = { id: 'a', name: 'A' };
    const existing = new Map([['a', await row(poller, item)]]);
    const { candidates, unchanged } = await prepareCandidates(poller, [item], existing);
    expect(unchanged).toEqual([]);
    expect(candidates).toHaveLength(1);
  });

  it('lets the last duplicate identity win, keeping the first position', async () => {
    const poller = makePoller();
    const items: Item[] = [
      { id: 'a', name: 'first' },
      { id: 'b', name: 'B' },
      { id: 'a', name: 'last' },
    ];
    const { candidates } = await prepareCandidates(poller, items, new Map());
    expect(candidates.map((c) => c.identity)).toEqual(['a', 'b']);
    expect(candidates[0]?.item).toEqual({ id: 'a', name: 'last' });
    expect(candidates[0]?.hash).toBe(await hashValue({ id: 'a', name: 'last' }));
  });

  it('coerces numeric identities and rejects non-scalar ones', async () => {
    const numeric = definePoller({
      name: 'n',
      identity: (i: { id: number }) => i.id as unknown as string,
      cursor: { strategy: 'snapshotDiff' },
      fetch: async () => ({ items: [] }),
    }).resolved;
    const { candidates } = await prepareCandidates(numeric, [{ id: 7 }], new Map());
    expect(candidates[0]?.identity).toBe('7');

    const broken = definePoller({
      name: 'b',
      identity: (i: { id?: string }) => i.id as string,
      cursor: { strategy: 'snapshotDiff' },
      fetch: async () => ({ items: [] }),
    }).resolved;
    await expect(prepareCandidates(broken, [{}], new Map())).rejects.toThrow(
      /identity\(\) must return a string, got undefined/,
    );
  });
});

describe('diffCandidates', () => {
  it('classifies created / updated / unchanged', async () => {
    const poller = makePoller();
    const kept: Item = { id: 'kept', name: 'K' };
    const changed: Item = { id: 'changed', name: 'old' };
    const existing = new Map<string, ItemRow>([
      ['kept', await row(poller, kept)],
      ['changed', await row(poller, changed)],
    ]);
    const changedNow: Item = { id: 'changed', name: 'new' };
    const created: Item = { id: 'new', name: 'N' };
    const { candidates } = await prepareCandidates(poller, [kept, changedNow, created], existing);
    const result = diffCandidates(poller, candidates, existing, { now: NOW });

    expect(result.changes.map((c) => [c.type, c.identity])).toEqual([
      ['updated', 'changed'],
      ['created', 'new'],
    ]);
    expect(result.unchanged).toEqual(['kept']);
    expect(result.rebaselined).toEqual([]);
    expect(result.upserts.map((u) => u.identity)).toEqual(['changed', 'new']);
    for (const upsert of result.upserts) {
      expect(upsert.seenAt).toBe(NOW);
      expect(upsert.schemaVersion).toBe(1);
      expect(upsert.version).toBeNull();
      expect('payload' in upsert).toBe(false);
    }
    const updated = result.changes[0];
    expect(updated?.item).toEqual(changedNow);
    expect(updated?.previous).toBeUndefined();
    expect(updated?.hash).toBe(await hashValue(changedNow));
  });

  it('with retain: payload stores payload and exposes previous on updates', async () => {
    const poller = makePoller({ retain: 'payload' });
    const before: Item = { id: 'a', name: 'before' };
    const after: Item = { id: 'a', name: 'after' };
    const existing = new Map([['a', await row(poller, before, { payload: before })]]);
    const { candidates } = await prepareCandidates(
      poller,
      [after, { id: 'b', name: 'B' }],
      existing,
    );
    const result = diffCandidates(poller, candidates, existing, { now: NOW });

    expect(result.changes[0]).toMatchObject({ type: 'updated', previous: before, item: after });
    expect(result.changes[1]).toMatchObject({ type: 'created', previous: undefined });
    expect(result.upserts[0]?.payload).toEqual(after);
    expect(result.upserts[1]?.payload).toEqual({ id: 'b', name: 'B' });
  });

  it('with retain: hash leaves previous undefined even if a payload was stored', async () => {
    const poller = makePoller({ retain: 'hash' });
    const before: Item = { id: 'a', name: 'before' };
    const existing = new Map([['a', await row(poller, before, { payload: before })]]);
    const { candidates } = await prepareCandidates(poller, [{ id: 'a', name: 'after' }], existing);
    const result = diffCandidates(poller, candidates, existing, { now: NOW });
    expect(result.changes[0]?.previous).toBeUndefined();
    expect('payload' in (result.upserts[0] as ItemRow)).toBe(false);
  });

  it("rebaselines drifted rows silently with onSchemaChange: 'rebaseline'", async () => {
    const poller = makePoller({
      schemaVersion: 2,
      onSchemaChange: 'rebaseline',
      retain: 'payload',
    });
    const item: Item = { id: 'a', name: 'A' };
    const existing = new Map([
      ['a', await row(poller, { id: 'a', name: 'old' }, { schemaVersion: 1 })],
    ]);
    const { candidates } = await prepareCandidates(poller, [item], existing);
    const result = diffCandidates(poller, candidates, existing, { now: NOW });

    expect(result.changes).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.rebaselined).toEqual(['a']);
    expect(result.upserts).toEqual([
      {
        identity: 'a',
        version: null,
        hash: await hashValue(item),
        schemaVersion: 2,
        payload: item,
        seenAt: NOW,
      },
    ]);
  });

  it("emits updated for drifted rows whose hash changed with onSchemaChange: 'emit'", async () => {
    const poller = makePoller({ schemaVersion: 2, onSchemaChange: 'emit' });
    const changed: Item = { id: 'changed', name: 'new' };
    const same: Item = { id: 'same', name: 'S' };
    const existing = new Map<string, ItemRow>([
      ['changed', await row(poller, { id: 'changed', name: 'old' }, { schemaVersion: 1 })],
      ['same', await row(poller, same, { schemaVersion: 1 })],
    ]);
    const { candidates } = await prepareCandidates(poller, [changed, same], existing);
    const result = diffCandidates(poller, candidates, existing, { now: NOW });

    expect(result.changes.map((c) => [c.type, c.identity])).toEqual([['updated', 'changed']]);
    expect(result.rebaselined).toEqual(['same']);
    expect(result.unchanged).toEqual([]);
    expect(result.upserts.map((u) => [u.identity, u.schemaVersion])).toEqual([
      ['changed', 2],
      ['same', 2],
    ]);
  });

  it('upserts unchanged rows only with touchUnchanged', async () => {
    const poller = makePoller();
    const item: Item = { id: 'a', name: 'A' };
    const existing = new Map([['a', await row(poller, item, { seenAt: 1 })]]);
    const { candidates } = await prepareCandidates(poller, [item], existing);

    const quiet = diffCandidates(poller, candidates, existing, { now: NOW });
    expect(quiet.unchanged).toEqual(['a']);
    expect(quiet.upserts).toEqual([]);

    const touched = diffCandidates(poller, candidates, existing, {
      now: NOW,
      touchUnchanged: true,
    });
    expect(touched.unchanged).toEqual(['a']);
    expect(touched.changes).toEqual([]);
    expect(touched.upserts).toEqual([
      { identity: 'a', version: null, hash: await hashValue(item), schemaVersion: 1, seenAt: NOW },
    ]);
  });

  it('refreshes the stored version when it changed but the fingerprint did not', async () => {
    const poller = makePoller({
      version: (i) => i.updatedAt ?? '',
      fingerprint: (i) => i.name,
    });
    const item: Item = { id: 'a', name: 'A', updatedAt: 'v2' };
    const existing = new Map([['a', await row(poller, { ...item, updatedAt: 'v1' })]]);
    const { candidates } = await prepareCandidates(poller, [item], existing);
    const result = diffCandidates(poller, candidates, existing, { now: NOW });
    expect(result.changes).toEqual([]);
    expect(result.unchanged).toEqual(['a']);
    expect(result.upserts).toEqual([
      { identity: 'a', version: 'v2', hash: await hashValue('A'), schemaVersion: 1, seenAt: NOW },
    ]);
  });

  it('handles an empty page', () => {
    const poller = makePoller();
    expect(diffCandidates(poller, [], new Map(), { now: NOW })).toEqual({
      changes: [],
      upserts: [],
      unchanged: [],
      rebaselined: [],
    });
  });
});

describe('detectDeletes', () => {
  it('returns identities missing from seen, sorted', () => {
    const existing = ['c', 'a', 'b', 'd'];
    expect(detectDeletes(existing, new Set(['b']))).toEqual(['a', 'c', 'd']);
    expect(detectDeletes(existing, new Set(existing))).toEqual([]);
    expect(detectDeletes([], new Set(['x']))).toEqual([]);
  });

  it('accepts any iterable and sorts by UTF-16 code units', () => {
    const existing = new Set(['b', 'B', '10', '9', 'é']);
    expect(detectDeletes(existing, new Set())).toEqual(['10', '9', 'B', 'b', 'é']);
  });
});

describe('end-to-end create/update/unchanged/delete matrix', () => {
  it('matches the expected matrix over two cycles', async () => {
    const poller = makePoller({ retain: 'payload' });
    const store = new Map<string, ItemRow>();

    const page1: Item[] = [
      { id: '1', name: 'one' },
      { id: '2', name: 'two' },
      { id: '3', name: 'three' },
    ];
    const prep1 = await prepareCandidates(poller, page1, store);
    const diff1 = diffCandidates(poller, prep1.candidates, store, { now: 1 });
    expect(diff1.changes.map((c) => c.type)).toEqual(['created', 'created', 'created']);
    for (const u of diff1.upserts) store.set(u.identity, u);
    expect(detectDeletes(store.keys(), new Set(page1.map((i) => i.id)))).toEqual([]);

    const page2: Item[] = [
      { id: '1', name: 'one' },
      { id: '2', name: 'TWO' },
      { id: '4', name: 'four' },
    ];
    const prep2 = await prepareCandidates(poller, page2, store);
    const diff2 = diffCandidates(poller, prep2.candidates, store, { now: 2 });
    expect(diff2.changes.map((c) => [c.type, c.identity])).toEqual([
      ['updated', '2'],
      ['created', '4'],
    ]);
    expect(diff2.changes[0]?.previous).toEqual({ id: '2', name: 'two' });
    expect(diff2.unchanged).toEqual(['1']);
    const seen = new Set([...prep2.unchanged, ...prep2.candidates.map((c) => c.identity)]);
    expect(detectDeletes(store.keys(), seen)).toEqual(['3']);
  });
});
