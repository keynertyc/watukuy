import { describe, expect, it } from 'vitest';
import { definePoller } from '../core/define-poller.ts';
import { fingerprintOf, hashValue } from './hash.ts';

const HEX64 = /^[0-9a-f]{64}$/;

describe('hashValue', () => {
  it('is SHA-256 of the canonical form (known vector)', async () => {
    // printf '%s' '{"a":1}' | shasum -a 256
    expect(await hashValue({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
    // printf '%s' 'null' | shasum -a 256
    expect(await hashValue(undefined)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
    expect(await hashValue(null)).toBe(await hashValue(undefined));
  });

  it('is stable across key order, whitespace-free, and number forms', async () => {
    const a = await hashValue({ b: [1.0, { y: 2, x: 1e21 }], a: 'x' });
    const b = await hashValue({ a: 'x', b: [1, { x: 1e21, y: 2 }] });
    expect(a).toBe(b);
    expect(a).toMatch(HEX64);
  });

  it('differs when content differs', async () => {
    expect(await hashValue({ a: 1 })).not.toBe(await hashValue({ a: 2 }));
    expect(await hashValue({ a: 1 })).not.toBe(await hashValue({ a: '1' }));
    expect(await hashValue([1, 2])).not.toBe(await hashValue([2, 1]));
  });

  it('propagates canonicalization errors', async () => {
    await expect(hashValue({ n: Number.NaN })).rejects.toThrow(TypeError);
  });
});

describe('fingerprintOf', () => {
  interface Order {
    id: string;
    status: string;
    total: number;
    fetchedAt: string;
  }
  const base = {
    identity: (o: Order) => o.id,
    cursor: { strategy: 'snapshotDiff' } as const,
    fetch: async () => ({ items: [] as Order[] }),
  };

  it('hashes the whole item without a fingerprint selector', async () => {
    const poller = definePoller({ name: 'orders', ...base }).resolved;
    const item: Order = { id: 'o1', status: 'paid', total: 10, fetchedAt: 't1' };
    expect(await fingerprintOf(poller, item)).toBe(await hashValue(item));
    expect(await fingerprintOf(poller, item)).not.toBe(
      await fingerprintOf(poller, { ...item, fetchedAt: 't2' }),
    );
  });

  it('ignores fields outside the fingerprint selector', async () => {
    const poller = definePoller({
      name: 'orders',
      ...base,
      fingerprint: (o) => ({ status: o.status, total: o.total }),
    }).resolved;
    const item: Order = { id: 'o1', status: 'paid', total: 10, fetchedAt: 't1' };
    const h1 = await fingerprintOf(poller, item);
    expect(h1).toBe(await fingerprintOf(poller, { ...item, fetchedAt: 'later', id: 'other' }));
    expect(h1).toBe(await hashValue({ total: 10, status: 'paid' }));
    expect(h1).not.toBe(await fingerprintOf(poller, { ...item, status: 'shipped' }));
  });
});
