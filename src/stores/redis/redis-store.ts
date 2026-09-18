import { LeaseLostError } from '../../core/errors.ts';
import type {
  CommitBatch,
  ItemRow,
  Lease,
  LoggedEvent,
  OutboxRow,
  ParkedRow,
  PKey,
  PollerState,
  StateStore,
  StoreCapabilities,
  Validator,
} from '../../core/store-types.ts';
import { emptyPollerState } from '../memory/memory-store.ts';
import { adaptRedisClient, type RedisLike } from './client.ts';
import {
  ACK_EVENTS,
  ACQUIRE_LEASE,
  COMMIT_POLL,
  DISCARD_PARKED,
  LEASE_LOST,
  PARK_EVENT,
  RECORD_ATTEMPT,
  RELEASE_LEASE,
  RENEW_LEASE,
  RETRY_PARKED,
  SAVE_STATE,
  SAVE_STATE_UNFENCED,
  SET_VALIDATOR,
} from './scripts.ts';

/** Options for {@link RedisStore}. */
export interface RedisStoreOptions {
  /**
   * A connected Redis client: an `ioredis` `Redis`/`Cluster` instance, a node-redis client
   * (`await createClient({ url }).connect()`), or any object implementing `RedisLike`.
   * The store never opens or closes the connection; you own its lifecycle.
   */
  client: unknown;
  /** Key prefix for every key the store writes. @default 'watukuy:' */
  prefix?: string | undefined;
}

/** Every Redis key used for one `(poller, partition)`. */
interface KeySet {
  meta: string;
  state: string;
  items: string;
  outbox: string;
  rows: string;
  attempts: string;
  errors: string;
  parked: string;
  hold: string;
  validators: string;
  log: string;
}

/** Mutable per-row delivery data kept outside the immutable row JSON (see `recordAttempt`). */
interface AttemptInfo {
  lastError: OutboxRow['lastError'];
  nextAttemptAt: number | null;
}

type StatePatch = Partial<Omit<PollerState, 'createdAt'>>;

const LOG_PAGE = 500;
const ZREM_BATCH = 1000;

/**
 * Redis-backed `StateStore` (PLAN §6). Works with `ioredis` and node-redis (`redis`); the client
 * is auto-detected.
 *
 * Layout, under `{prefix}p:{poller}:{partition}` (components URI-encoded):
 *
 * - `:meta` hash — lease owner/epoch/expiry and the monotonic `epoch_counter`;
 * - `:state` hash — one JSON field per top-level `PollerState` property, so a patch is a plain
 *   top-level merge with no server-side JSON decoding;
 * - `:items` hash identity → `ItemRow` JSON;
 * - `:outbox` sorted set (score = sequence) of *pending* event ids, `:outbox:rows` hash
 *   eventId → `OutboxRow` JSON, `:outbox:attempts` / `:outbox:errors` hashes with the delivery
 *   counters updated by `recordAttempt`;
 * - `:parked` hash id → `ParkedRow` JSON and `:parked:hold` hash id → held ordering key;
 * - `:validators` hash urlHash → `Validator` JSON;
 * - `:log` sorted set (score = sequence) of `LoggedEvent` JSON.
 *
 * `{prefix}keys` is a set of every `(poller, partition)` ever written, for `listKeys()`.
 *
 * Every fenced write is one Lua script that verifies `lease_owner`/`lease_epoch` before mutating,
 * so `commitPoll` is all-or-nothing and stale epochs are rejected with `LeaseLostError`.
 * `migrate()` is a no-op and `close()` does **not** disconnect the client you passed in.
 *
 * Redis Cluster is not supported in this version: scripts touch the global `keys` set together
 * with per-key hashes, which live in different slots.
 *
 * @example
 * import { Redis } from 'ioredis';
 * import { RedisStore } from 'watukuy/store-redis';
 *
 * const store = new RedisStore({ client: new Redis(process.env.REDIS_URL) });
 * const engine = createWatukuy({ store, pollers: { orders } });
 */
export class RedisStore implements StateStore {
  readonly capabilities: StoreCapabilities = { transactions: true, log: true, streaming: true };
  private readonly client: RedisLike;
  private readonly prefix: string;

  constructor(options: RedisStoreOptions) {
    this.client = adaptRedisClient(options.client);
    this.prefix = options.prefix ?? 'watukuy:';
  }

  private keys(key: PKey): KeySet {
    const k = `${this.prefix}p:${encodeURIComponent(key.poller)}:${encodeURIComponent(key.partition)}`;
    return {
      meta: `${k}:meta`,
      state: `${k}:state`,
      items: `${k}:items`,
      outbox: `${k}:outbox`,
      rows: `${k}:outbox:rows`,
      attempts: `${k}:outbox:attempts`,
      errors: `${k}:outbox:errors`,
      parked: `${k}:parked`,
      hold: `${k}:parked:hold`,
      validators: `${k}:validators`,
      log: `${k}:log`,
    };
  }

  private get keysSet(): string {
    return `${this.prefix}keys`;
  }

  private member(key: PKey): string {
    return JSON.stringify([key.poller, key.partition]);
  }

  /** Run a fenced script and translate the `LEASE_LOST` sentinel into `LeaseLostError`. */
  private async fenced(
    key: PKey,
    lease: Lease,
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    const reply = await this.client.eval(script, keys, [lease.owner, String(lease.epoch), ...args]);
    if (reply === LEASE_LOST) throw new LeaseLostError(key.poller, key.partition, lease.epoch);
    return reply;
  }

  async migrate(): Promise<void> {}

  /** No-op: the store does not own the client connection. Close your Redis client yourself. */
  async close(): Promise<void> {}

  async acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null> {
    const k = this.keys(key);
    const expiresAt = now + ttlMs;
    const reply = await this.client.eval(
      ACQUIRE_LEASE,
      [k.meta, this.keysSet],
      [owner, String(now), String(expiresAt), this.member(key)],
    );
    if (reply === null || reply === undefined) return null;
    return { owner, epoch: Number(reply), expiresAt };
  }

  async renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean> {
    const k = this.keys(key);
    const reply = await this.client.eval(
      RENEW_LEASE,
      [k.meta],
      [lease.owner, String(lease.epoch), String(now + ttlMs)],
    );
    return Number(reply) === 1;
  }

  async releaseLease(key: PKey, lease: Lease): Promise<void> {
    const k = this.keys(key);
    await this.client.eval(RELEASE_LEASE, [k.meta], [lease.owner, String(lease.epoch)]);
  }

  async getLease(key: PKey): Promise<Lease | null> {
    const k = this.keys(key);
    const [owner, epoch, expiresAt] = await this.client.hmget(k.meta, [
      'lease_owner',
      'lease_epoch',
      'lease_expires_at',
    ]);
    if (owner === null || owner === undefined) return null;
    return { owner, epoch: Number(epoch ?? 0), expiresAt: Number(expiresAt ?? 0) };
  }

  async loadState(key: PKey): Promise<PollerState | null> {
    const k = this.keys(key);
    const hash = await this.client.hgetall(k.state);
    if (Object.keys(hash).length === 0) return null;
    const zero = emptyPollerState(0);
    const field = <T>(name: keyof PollerState, fallback: T): T => {
      const raw = hash[name];
      return raw === undefined ? fallback : (JSON.parse(raw) as T);
    };
    return {
      lanes: field('lanes', zero.lanes),
      schedule: field('schedule', zero.schedule),
      paused: field('paused', zero.paused),
      schemaVersion: field('schemaVersion', zero.schemaVersion),
      sequence: field('sequence', zero.sequence),
      createdAt: field('createdAt', zero.createdAt),
      updatedAt: field('updatedAt', zero.updatedAt),
    };
  }

  /** Flatten a state patch into `[count, field, json, ...]` for the Lua `apply_state` helper. */
  private patchArgs(patch: StatePatch): string[] {
    const pairs: string[] = [];
    let n = 0;
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined || name === 'createdAt') continue;
      pairs.push(name, JSON.stringify(value));
      n++;
    }
    return [String(patch.updatedAt ?? 0), String(n), ...pairs];
  }

  async saveState(key: PKey, lease: Lease, patch: StatePatch): Promise<void> {
    const k = this.keys(key);
    await this.fenced(
      key,
      lease,
      SAVE_STATE,
      [k.meta, k.state, this.keysSet],
      [this.member(key), ...this.patchArgs(patch)],
    );
  }

  async saveStateUnfenced(key: PKey, patch: StatePatch): Promise<void> {
    const k = this.keys(key);
    await this.client.eval(
      SAVE_STATE_UNFENCED,
      [k.state, this.keysSet],
      [this.member(key), ...this.patchArgs(patch)],
    );
  }

  async listKeys(poller?: string): Promise<PKey[]> {
    const members = await this.client.smembers(this.keysSet);
    const out: PKey[] = [];
    for (const m of members) {
      const parsed: unknown = JSON.parse(m);
      if (!Array.isArray(parsed) || parsed.length !== 2) continue;
      const [p, partition] = parsed as [unknown, unknown];
      if (typeof p !== 'string' || typeof partition !== 'string') continue;
      if (poller === undefined || p === poller) out.push({ poller: p, partition });
    }
    return out.sort(
      (a, b) => a.poller.localeCompare(b.poller) || a.partition.localeCompare(b.partition),
    );
  }

  async deleteKey(key: PKey): Promise<void> {
    const k = this.keys(key);
    await this.client.del(Object.values(k));
    await this.client.srem(this.keysSet, [this.member(key)]);
  }

  async clearItems(key: PKey): Promise<void> {
    await this.client.del([this.keys(key).items]);
  }

  async loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>> {
    const out = new Map<string, ItemRow>();
    if (identities.length === 0) return out;
    const values = await this.client.hmget(this.keys(key).items, identities);
    identities.forEach((identity, i) => {
      const json = values[i];
      if (json !== null && json !== undefined) out.set(identity, JSON.parse(json) as ItemRow);
    });
    return out;
  }

  async *streamIdentities(key: PKey, batchSize = 1000): AsyncIterable<string[]> {
    const size = Math.max(1, Math.floor(batchSize));
    const items = this.keys(key).items;
    const seen = new Set<string>();
    let buffer: string[] = [];
    let cursor = '0';
    do {
      const page = await this.client.hscanFields(items, cursor, size);
      cursor = page.cursor;
      for (const identity of page.fields) {
        if (seen.has(identity)) continue;
        seen.add(identity);
        buffer.push(identity);
      }
      while (buffer.length >= size) {
        yield buffer.slice(0, size);
        buffer = buffer.slice(size);
      }
    } while (cursor !== '0');
    if (buffer.length > 0) yield buffer;
  }

  async countItems(key: PKey): Promise<number> {
    return this.client.hlen(this.keys(key).items);
  }

  async commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void> {
    const k = this.keys(key);
    const args: string[] = [this.member(key), ...this.patchArgs(batch.statePatch)];

    args.push(String(batch.upserts.length));
    for (const row of batch.upserts) args.push(row.identity, JSON.stringify(row));

    args.push(String(batch.deletes.length));
    for (const identity of batch.deletes) args.push(identity);

    args.push(String(batch.events.length));
    for (const row of batch.events) {
      const logged: LoggedEvent | null = batch.log
        ? { sequence: row.sequence, event: row.event, createdAt: row.createdAt }
        : null;
      args.push(
        row.eventId,
        String(row.sequence),
        row.status,
        JSON.stringify(row),
        logged ? JSON.stringify(logged) : '',
      );
    }

    const parked = batch.parked ?? [];
    args.push(String(parked.length));
    for (const row of parked) {
      args.push(row.id, JSON.stringify(row), row.holdKey === null ? '0' : '1', row.holdKey ?? '');
    }

    await this.fenced(
      key,
      lease,
      COMMIT_POLL,
      [
        k.meta,
        k.state,
        k.items,
        k.outbox,
        k.rows,
        k.attempts,
        k.errors,
        k.parked,
        k.hold,
        k.log,
        this.keysSet,
      ],
      args,
    );
  }

  async loadPending(key: PKey, limit: number): Promise<OutboxRow[]> {
    if (!(limit > 0)) return [];
    const k = this.keys(key);
    const ids = await this.client.zrangebyscore(k.outbox, '-inf', '+inf', 0, Math.floor(limit));
    if (ids.length === 0) return [];
    const [rows, attempts, errors] = await Promise.all([
      this.client.hmget(k.rows, ids),
      this.client.hmget(k.attempts, ids),
      this.client.hmget(k.errors, ids),
    ]);
    const out: OutboxRow[] = [];
    ids.forEach((_, i) => {
      const json = rows[i];
      if (json === null || json === undefined) return;
      const row = JSON.parse(json) as OutboxRow;
      const extra = attempts[i];
      if (extra !== null && extra !== undefined) row.attempts += Number(extra);
      const err = errors[i];
      if (err !== null && err !== undefined) {
        const info = JSON.parse(err) as AttemptInfo;
        row.lastError = info.lastError;
        row.nextAttemptAt = info.nextAttemptAt;
      }
      out.push(row);
    });
    return out;
  }

  async countPending(key: PKey): Promise<number> {
    return this.client.zcard(this.keys(key).outbox);
  }

  async ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void> {
    const k = this.keys(key);
    await this.fenced(
      key,
      lease,
      ACK_EVENTS,
      [k.meta, k.outbox, k.rows, k.attempts, k.errors],
      eventIds,
    );
  }

  async recordAttempt(
    key: PKey,
    lease: Lease,
    eventId: string,
    error: OutboxRow['lastError'],
    nextAttemptAt: number | null,
  ): Promise<void> {
    const k = this.keys(key);
    const info: AttemptInfo = { lastError: error ?? null, nextAttemptAt };
    await this.fenced(
      key,
      lease,
      RECORD_ATTEMPT,
      [k.meta, k.rows, k.attempts, k.errors],
      [eventId, JSON.stringify(info)],
    );
  }

  async parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void> {
    const k = this.keys(key);
    await this.fenced(
      key,
      lease,
      PARK_EVENT,
      [k.meta, k.parked, k.hold, k.outbox, k.rows, k.attempts, k.errors, this.keysSet],
      [
        this.member(key),
        row.id,
        JSON.stringify(row),
        row.holdKey === null ? '0' : '1',
        row.holdKey ?? '',
        row.event ? '1' : '0',
        row.event?.id ?? '',
      ],
    );
  }

  async listParked(
    key: PKey,
    opts: { kind?: 'poison' | 'invalid'; limit?: number } = {},
  ): Promise<ParkedRow[]> {
    const values = await this.client.hvals(this.keys(key).parked);
    const rows = values
      .map((json) => JSON.parse(json) as ParkedRow)
      .filter((r) => opts.kind === undefined || r.kind === opts.kind)
      .sort((a, b) => a.parkedAt - b.parkedAt);
    return rows.slice(0, opts.limit ?? rows.length);
  }

  async countParked(key: PKey): Promise<number> {
    return this.client.hlen(this.keys(key).parked);
  }

  async retryParked(key: PKey, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const k = this.keys(key);
    const values = await this.client.hmget(k.parked, ids);
    const args: string[] = [];
    let n = 0;
    ids.forEach((id, i) => {
      const json = values[i];
      if (json === null || json === undefined) return;
      const row = JSON.parse(json) as ParkedRow;
      if (row.kind !== 'poison' || !row.event) return;
      const outbox: OutboxRow = {
        eventId: row.event.id,
        sequence: row.event.sequence,
        event: row.event,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        createdAt: row.parkedAt,
      };
      args.push(id, outbox.eventId, String(outbox.sequence), JSON.stringify(outbox));
      n++;
    });
    if (n === 0) return 0;
    const reply = await this.client.eval(
      RETRY_PARKED,
      [k.parked, k.hold, k.outbox, k.rows, k.attempts, k.errors],
      [String(n), ...args],
    );
    return Number(reply);
  }

  async discardParked(key: PKey, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const k = this.keys(key);
    const reply = await this.client.eval(DISCARD_PARKED, [k.parked, k.hold], ids);
    return Number(reply);
  }

  async heldKeys(key: PKey): Promise<Set<string>> {
    return new Set(await this.client.hvals(this.keys(key).hold));
  }

  async getValidator(key: PKey, urlHash: string): Promise<Validator | null> {
    const [json] = await this.client.hmget(this.keys(key).validators, [urlHash]);
    return json === null || json === undefined ? null : (JSON.parse(json) as Validator);
  }

  async setValidator(
    key: PKey,
    lease: Lease,
    urlHash: string,
    validator: Validator,
  ): Promise<void> {
    const k = this.keys(key);
    await this.fenced(
      key,
      lease,
      SET_VALIDATOR,
      [k.meta, k.validators, this.keysSet],
      [this.member(key), urlHash, JSON.stringify(validator)],
    );
  }

  async readLog(
    key: PKey,
    range: { afterSequence?: number; fromTime?: number; toTime?: number },
    limit: number,
  ): Promise<LoggedEvent[]> {
    if (!(limit > 0)) return [];
    const log = this.keys(key).log;
    const min = range.afterSequence === undefined ? '-inf' : `(${range.afterSequence}`;
    const page = Math.max(Math.floor(limit), LOG_PAGE);
    const out: LoggedEvent[] = [];
    let offset = 0;
    for (;;) {
      const members = await this.client.zrangebyscore(log, min, '+inf', offset, page);
      for (const m of members) {
        const entry = JSON.parse(m) as LoggedEvent;
        if (range.fromTime !== undefined && entry.createdAt < range.fromTime) continue;
        if (range.toTime !== undefined && entry.createdAt > range.toTime) continue;
        out.push(entry);
        if (out.length >= limit) return out;
      }
      if (members.length < page) return out;
      offset += page;
    }
  }

  async pruneLog(key: PKey, olderThan: number): Promise<number> {
    const log = this.keys(key).log;
    const stale: string[] = [];
    let offset = 0;
    for (;;) {
      const members = await this.client.zrangebyscore(log, '-inf', '+inf', offset, LOG_PAGE);
      for (const m of members) {
        const entry = JSON.parse(m) as LoggedEvent;
        if (entry.createdAt < olderThan) stale.push(m);
      }
      if (members.length < LOG_PAGE) break;
      offset += LOG_PAGE;
    }
    let removed = 0;
    for (let i = 0; i < stale.length; i += ZREM_BATCH) {
      removed += await this.client.zrem(log, stale.slice(i, i + ZREM_BATCH));
    }
    return removed;
  }
}
