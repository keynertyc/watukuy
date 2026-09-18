import { describe, expect, it } from 'vitest';
import { createWatukuy, definePoller, MemoryStore } from '../index.ts';
import { FakeApi, SeededRandom, VirtualClock } from '../testing/index.ts';
import { type CliIo, runCli } from './cli.ts';

interface Item {
  id: string;
  updatedAt: string;
  n: number;
  [k: string]: unknown;
}

function setup() {
  const clock = new VirtualClock('2026-03-01T00:00:00Z');
  const api = new FakeApi<Item>({ clock, identity: (i) => i.id, timestampField: 'updatedAt' });
  api.add({ id: 'a', updatedAt: clock.iso(), n: 1 });
  api.add({ id: 'b', updatedAt: clock.iso(), n: 2 });
  const orders = definePoller({
    name: 'orders',
    identity: (o: Item) => o.id,
    version: (o) => o.updatedAt,
    cursor: { strategy: 'timestamp', field: 'updatedAt', tieBreak: 'id', initial: null },
    fetch: async ({ cursor }) => {
      const r = api.listSince({ since: cursor.value, afterId: cursor.tieBreak });
      return { items: r.items, hasMore: r.hasMore };
    },
    schedule: { min: '5s', max: '1m', jitter: 0 },
    delivery: { retry: { attempts: 1 } },
    log: { retention: '1d' },
  });
  const engine = createWatukuy({
    store: new MemoryStore(),
    pollers: { orders },
    clock,
    random: new SeededRandom(1),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    instanceId: 'cli-test',
  });
  const delivered: string[] = [];
  let fail = false;
  engine.on('orders', async (e) => {
    if (fail) throw new Error('nope');
    delivered.push(`${e.type}:${e.subject}`);
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    loadModule: async () => ({ default: engine }),
    cwd: '/tmp',
  };
  return {
    engine,
    api,
    clock,
    io,
    out,
    err,
    delivered,
    setFail: (v: boolean) => {
      fail = v;
    },
    run: (args: string[]) => runCli(['--config', 'x.ts', ...args], io),
  };
}

describe('watukuy CLI', () => {
  it('prints help and version', async () => {
    const s = setup();
    expect(await runCli(['--help'], s.io)).toBe(0);
    expect(s.out.join('\n')).toMatch(/Usage: watukuy/);
    expect(await runCli(['--version'], s.io)).toBe(0);
    expect(await runCli([], s.io)).toBe(1);
  });

  it('rejects unknown flags and commands', async () => {
    const s = setup();
    expect(await runCli(['--bogus'], s.io)).toBe(2);
    expect(s.err[0]).toMatch(/error:/);
    expect(await s.run(['frobnicate'])).toBe(2);
  });

  it('tick, inspect, trigger, pause, resume', async () => {
    const s = setup();
    expect(await s.run(['tick'])).toBe(0);
    expect(s.delivered).toEqual(['created:a', 'created:b']);
    expect(s.out.at(-1)).toMatch(/1 polled/);

    s.out.length = 0;
    expect(await s.run(['inspect', '--json'])).toBe(0);
    const report = JSON.parse(s.out.join('\n')) as {
      pollers: Array<{ items: number; poller: string }>;
    };
    expect(report.pollers[0]).toMatchObject({ poller: 'orders', items: 2 });

    s.out.length = 0;
    expect(await s.run(['inspect'])).toBe(0);
    expect(s.out.join('\n')).toMatch(/orders.*items=2/);

    expect(await s.run(['pause', '--poller', 'orders'])).toBe(0);
    await s.clock.advance(10_000);
    s.api.update('a', { n: 5 });
    expect(await s.run(['tick', '--json'])).toBe(0);
    expect(s.delivered).toHaveLength(2); // paused
    expect(await s.run(['resume', '--poller', 'orders'])).toBe(0);
    expect(await s.run(['trigger', '--poller', 'orders'])).toBe(0);
    expect(await s.run(['tick'])).toBe(0);
    expect(s.delivered.at(-1)).toBe('updated:a');
  });

  it('requires --poller where needed and reports engine errors with codes', async () => {
    const s = setup();
    expect(await s.run(['trigger'])).toBe(1);
    expect(s.err.at(-1)).toMatch(/error \(CONFIG\): trigger requires --poller/);
    expect(await s.run(['trigger', '--poller', 'nope'])).toBe(1);
    expect(s.err.at(-1)).toMatch(/UNKNOWN_POLLER/);
  });

  it('parked ls / retry / discard', async () => {
    const s = setup();
    s.setFail(true);
    expect(await s.run(['tick'])).toBe(0);
    s.out.length = 0;
    expect(await s.run(['parked', 'ls', '--poller', 'orders', '--json'])).toBe(0);
    const rows = JSON.parse(s.out.join('\n')) as Array<{ id: string; kind: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('poison');
    s.setFail(false);
    expect(await s.run(['parked', 'retry', '--poller', 'orders', '--ids', rows[0]?.id ?? ''])).toBe(
      0,
    );
    expect(
      await s.run(['parked', 'discard', '--poller', 'orders', '--ids', rows[1]?.id ?? '']),
    ).toBe(0);
    expect(await s.run(['tick'])).toBe(0);
    expect(s.delivered).toEqual(['created:a']);
    s.out.length = 0;
    expect(await s.run(['parked', '--poller', 'orders'])).toBe(0);
    expect(s.out.at(-1)).toBe('no parked events');
    expect(await s.run(['parked', 'retry', '--poller', 'orders'])).toBe(1);
  });

  it('backfill, reset-cursor, replay, migrate', async () => {
    const s = setup();
    expect(await s.run(['tick'])).toBe(0);
    expect(
      await s.run(['reset-cursor', '--poller', 'orders', '--to', 'null', '--clear-snapshot']),
    ).toBe(0);
    expect(await s.run(['tick'])).toBe(0);
    expect(s.delivered).toHaveLength(4);
    expect(await s.run(['backfill', '--poller', 'orders', '--from', 'null', '--force'])).toBe(0);
    expect(await s.run(['tick'])).toBe(0);
    expect(s.delivered).toHaveLength(6);
    s.out.length = 0;
    expect(await s.run(['replay', '--poller', 'orders', '--from', '0', '--json'])).toBe(0);
    expect(JSON.parse(s.out.join('\n'))).toEqual({ replayed: 6 });
    expect(await s.run(['migrate'])).toBe(0);
    expect(await s.run(['replay', '--poller', 'orders'])).toBe(1);
  });

  it('run starts the engine and stops on the stop signal', async () => {
    const s = setup();
    let stop: () => void = () => {};
    s.io.waitForStop = () =>
      new Promise<void>((r) => {
        stop = r;
      });
    const p = s.run(['run']);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.engine.status).toBe('running');
    stop();
    expect(await p).toBe(0);
    expect(s.engine.status).toBe('stopped');
  });

  it('migrate without a config needs store flags', async () => {
    const s = setup();
    expect(await runCli(['migrate', '--store', 'sqlite'], s.io)).toBe(1);
    expect(s.err.at(-1)).toMatch(/--path/);
    expect(await runCli(['migrate', '--store', 'postgres'], s.io)).toBe(1);
    expect(s.err.at(-1)).toMatch(/--url/);
  });
});
