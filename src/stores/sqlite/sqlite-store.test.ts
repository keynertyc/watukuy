import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, LeaseLostError } from '../../core/errors.ts';
import type { PKey } from '../../core/store-types.ts';
import { storeContractSuite } from '../../testing/store-contract.ts';
import { SQLITE_TABLES, sqliteMigrations } from './schema.ts';
import { SqliteStore } from './sqlite-store.ts';

const KEY: PKey = { poller: 'orders', partition: '' };

storeContractSuite({
  name: 'SqliteStore (:memory:)',
  create: () => new SqliteStore({ path: ':memory:' }),
});

const fileDirs: string[] = [];
storeContractSuite({
  name: 'SqliteStore (file, WAL)',
  create: () => {
    const dir = mkdtempSync(join(tmpdir(), 'watukuy-sqlite-'));
    fileDirs.push(dir);
    return new SqliteStore({ path: join(dir, 'store.db'), busyTimeoutMs: 1_000 });
  },
  destroy: async (store) => {
    await store.close();
    const dir = fileDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  },
});

describe('SqliteStore file databases', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watukuy-sqlite-'));
    path = join(dir, 'shared.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("two instances on the same file see each other's data", async () => {
    const a = new SqliteStore({ path });
    const b = new SqliteStore({ path });
    try {
      const lease = await a.acquireLease(KEY, 'node-a', 30_000, 1_000);
      expect(lease).not.toBeNull();
      await a.commitPoll(KEY, lease!, {
        statePatch: { sequence: 1, updatedAt: 1_000 },
        upserts: [{ identity: 'x', version: 'v1', hash: 'h', schemaVersion: 1, seenAt: 1_000 }],
        deletes: [],
        events: [],
        log: false,
      });

      expect(await b.countItems(KEY)).toBe(1);
      expect(await b.getLease(KEY)).toEqual(lease);
      expect((await b.loadState(KEY))?.sequence).toBe(1);
      // The lease held through connection A fences writes coming through connection B.
      expect(await b.acquireLease(KEY, 'node-b', 30_000, 2_000)).toBeNull();
      await expect(
        b.saveState(KEY, { owner: 'node-b', epoch: 1, expiresAt: 0 }, { paused: true }),
      ).rejects.toBeInstanceOf(LeaseLostError);

      await b.saveStateUnfenced(KEY, { paused: true, updatedAt: 3_000 });
      expect((await a.loadState(KEY))?.paused).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('uses WAL journal mode for file databases', async () => {
    const store = new SqliteStore({ path });
    await store.migrate();
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      raw.close();
      await store.close();
    }
  });

  it('does not touch the file system until migrate() or first use', async () => {
    const store = new SqliteStore({ path });
    expect(existsSync(path)).toBe(false);
    await store.close();
    expect(existsSync(path)).toBe(false);
    await store.migrate();
    expect(existsSync(path)).toBe(true);
    await store.close();
  });

  it('applies the configured table prefix and reopens after close()', async () => {
    const store = new SqliteStore({ path, tablePrefix: 'custom_' });
    await store.migrate();
    const raw = new DatabaseSync(path);
    try {
      const names = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(names).toEqual(SQLITE_TABLES.map((t) => `custom_${t}`).sort());
    } finally {
      raw.close();
    }
    await store.saveStateUnfenced(KEY, { paused: true, updatedAt: 1 });
    await store.close();
    expect((await store.loadState(KEY))?.paused).toBe(true);
    await store.close();
  });

  it('exposes idempotent migration statements', () => {
    const statements = sqliteMigrations('x_');
    expect(statements.every((s) => s.includes('IF NOT EXISTS "x_'))).toBe(true);
    expect(statements.some((s) => s.includes('{prefix}'))).toBe(false);
  });

  it('rejects invalid options eagerly', () => {
    expect(() => new SqliteStore({ path: ':memory:', tablePrefix: 'bad-prefix;' })).toThrow(
      ConfigError,
    );
    expect(() => new SqliteStore({ path: '' })).toThrow(ConfigError);
    expect(() => new SqliteStore({ path: ':memory:', busyTimeoutMs: -1 })).toThrow(ConfigError);
  });
});
