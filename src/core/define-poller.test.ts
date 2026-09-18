import { describe, expect, it } from 'vitest';
import { definePoller, isPollerDefinition } from './define-poller.ts';
import { ConfigError } from './errors.ts';

const base = {
  name: 'orders',
  identity: (o: { id: string }) => o.id,
  cursor: { strategy: 'token', initial: null } as const,
  fetch: async () => ({ items: [] as { id: string }[] }),
};

describe('definePoller', () => {
  it('applies defaults and normalizes durations', () => {
    const p = definePoller({ ...base, schedule: { min: '5s', max: '2m' } });
    expect(isPollerDefinition(p)).toBe(true);
    expect(p.name).toBe('orders');
    expect(p.resolved.schedule).toMatchObject({
      minMs: 5_000,
      maxMs: 120_000,
      adaptive: true,
      jitter: 0.1,
    });
    expect(p.resolved.delivery).toMatchObject({
      concurrency: 1,
      retry: { attempts: 5 },
      poison: { action: 'park', holdKey: true },
      ackMode: 'auto',
    });
    expect(p.resolved.retain).toBe('hash');
    expect(p.resolved.maxPagesPerCycle).toBe(50);
    expect(p.resolved.circuit).toEqual({ failures: 5, probeEveryMs: 120_000 });
    expect(p.resolved.source).toBe('urn:watukuy:orders');
    expect(p.resolved.schemaVersion).toBe(1);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('rejects invalid names, missing identity/fetch, and bad cursors', () => {
    expect(() => definePoller({ ...base, name: 'bad name!' })).toThrow(ConfigError);
    expect(() => definePoller({ ...base, identity: undefined as never })).toThrow(/identity/);
    expect(() => definePoller({ ...base, fetch: undefined as never })).toThrow(/fetch/);
    expect(() =>
      definePoller({ ...base, cursor: { strategy: 'timestamp', field: '', initial: null } }),
    ).toThrow(/cursor.field/);
    expect(() => definePoller({ ...base, cursor: { strategy: 'nope' } as never })).toThrow(
      /unknown cursor strategy/,
    );
  });

  it('validates schedule, jitter, concurrency and schemaVersion', () => {
    expect(() => definePoller({ ...base, schedule: { min: '1m', max: '5s' } })).toThrow(
      /schedule.max/,
    );
    expect(() =>
      definePoller({ ...base, schedule: { min: '1s', max: '5s', jitter: 1.5 } }),
    ).toThrow(/jitter/);
    expect(() => definePoller({ ...base, delivery: { concurrency: 0 } })).toThrow(/concurrency/);
    expect(() => definePoller({ ...base, schemaVersion: 0 })).toThrow(/schemaVersion/);
    expect(() => definePoller({ ...base, maxPagesPerCycle: 0 })).toThrow(/maxPagesPerCycle/);
  });

  it('rejects reconcile on snapshotDiff and requires a Standard Schema when schema is given', () => {
    expect(() =>
      definePoller({
        ...base,
        cursor: { strategy: 'snapshotDiff' },
        reconcile: { every: '1h', fetch: async () => ({ items: [] }) },
      }),
    ).toThrow(/redundant with snapshotDiff/);
    expect(() => definePoller({ ...base, schema: { parse: () => 1 } as never })).toThrow(
      /Standard Schema/,
    );
  });

  it('accepts a Standard Schema and infers the item type from it', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) => ({ value: v as { id: string; total: number } }),
        types: undefined as { input: unknown; output: { id: string; total: number } } | undefined,
      },
    };
    const p = definePoller({
      name: 'typed',
      schema,
      identity: (o) => o.id,
      version: (o) => o.total,
      cursor: { strategy: 'page' },
      fetch: async () => ({ items: [{ id: 'x', total: 1 }] as unknown[] }),
    });
    expect(p.resolved.schema).toBe(schema);
  });
});
