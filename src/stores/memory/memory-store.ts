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

interface KeyRecord {
  key: PKey;
  state: PollerState | null;
  lease: Lease | null;
  epochCounter: number;
  items: Map<string, ItemRow>;
  outbox: Map<string, OutboxRow>;
  parked: Map<string, ParkedRow>;
  validators: Map<string, Validator>;
  log: LoggedEvent[];
}

const clone = <T>(value: T): T => structuredClone(value);

/** Zero state used when a patch arrives for a key that has never been saved. */
export function emptyPollerState(now: number): PollerState {
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

/**
 * In-memory `StateStore`. The reference implementation of the contract and the store used by
 * tests and the serverless example. Not durable across process restarts: use `SqliteStore`,
 * `PostgresStore`, or `RedisStore` in production.
 *
 * @example
 * const engine = createWatukuy({ store: new MemoryStore(), pollers: { orders } });
 */
export class MemoryStore implements StateStore {
  readonly capabilities: StoreCapabilities = { transactions: true, log: true, streaming: true };
  private readonly records = new Map<string, KeyRecord>();

  private id(key: PKey): string {
    return JSON.stringify([key.poller, key.partition]);
  }

  private record(key: PKey): KeyRecord {
    const id = this.id(key);
    let rec = this.records.get(id);
    if (!rec) {
      rec = {
        key: { poller: key.poller, partition: key.partition },
        state: null,
        lease: null,
        epochCounter: 0,
        items: new Map(),
        outbox: new Map(),
        parked: new Map(),
        validators: new Map(),
        log: [],
      };
      this.records.set(id, rec);
    }
    return rec;
  }

  /** Read-only lookup: never creates a record, so `listKeys()` only reports written keys. */
  private peek(key: PKey): KeyRecord | undefined {
    return this.records.get(this.id(key));
  }

  private fence(key: PKey, rec: KeyRecord, lease: Lease): void {
    if (!rec.lease || rec.lease.owner !== lease.owner || rec.lease.epoch !== lease.epoch) {
      throw new LeaseLostError(key.poller, key.partition, lease.epoch);
    }
  }

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null> {
    const rec = this.record(key);
    const current = rec.lease;
    if (current && current.expiresAt > now && current.owner !== owner) return null;
    rec.epochCounter += 1;
    rec.lease = { owner, epoch: rec.epochCounter, expiresAt: now + ttlMs };
    return clone(rec.lease);
  }

  async renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean> {
    const rec = this.record(key);
    if (!rec.lease || rec.lease.owner !== lease.owner || rec.lease.epoch !== lease.epoch) {
      return false;
    }
    rec.lease.expiresAt = now + ttlMs;
    return true;
  }

  async releaseLease(key: PKey, lease: Lease): Promise<void> {
    const rec = this.record(key);
    if (rec.lease && rec.lease.owner === lease.owner && rec.lease.epoch === lease.epoch) {
      rec.lease = null;
    }
  }

  async getLease(key: PKey): Promise<Lease | null> {
    const rec = this.records.get(this.id(key));
    return rec?.lease ? clone(rec.lease) : null;
  }

  async loadState(key: PKey): Promise<PollerState | null> {
    const rec = this.records.get(this.id(key));
    return rec?.state ? clone(rec.state) : null;
  }

  private applyPatch(rec: KeyRecord, patch: Partial<Omit<PollerState, 'createdAt'>>): void {
    const base = rec.state ?? emptyPollerState(patch.updatedAt ?? 0);
    rec.state = clone({ ...base, ...patch, createdAt: base.createdAt });
  }

  async saveState(
    key: PKey,
    lease: Lease,
    patch: Partial<Omit<PollerState, 'createdAt'>>,
  ): Promise<void> {
    const rec = this.record(key);
    this.fence(key, rec, lease);
    this.applyPatch(rec, patch);
  }

  async saveStateUnfenced(
    key: PKey,
    patch: Partial<Omit<PollerState, 'createdAt'>>,
  ): Promise<void> {
    this.applyPatch(this.record(key), patch);
  }

  async listKeys(poller?: string): Promise<PKey[]> {
    const out: PKey[] = [];
    for (const rec of this.records.values()) {
      if (poller === undefined || rec.key.poller === poller) out.push({ ...rec.key });
    }
    return out;
  }

  async deleteKey(key: PKey): Promise<void> {
    this.records.delete(this.id(key));
  }

  async clearItems(key: PKey): Promise<void> {
    this.peek(key)?.items.clear();
  }

  async loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>> {
    const out = new Map<string, ItemRow>();
    const rec = this.peek(key);
    if (!rec) return out;
    for (const id of identities) {
      const row = rec.items.get(id);
      if (row) out.set(id, clone(row));
    }
    return out;
  }

  async *streamIdentities(key: PKey, batchSize = 1000): AsyncIterable<string[]> {
    const rec = this.peek(key);
    if (!rec) return;
    const all = Array.from(rec.items.keys());
    for (let i = 0; i < all.length; i += batchSize) yield all.slice(i, i + batchSize);
  }

  async countItems(key: PKey): Promise<number> {
    return this.peek(key)?.items.size ?? 0;
  }

  async commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void> {
    const rec = this.record(key);
    this.fence(key, rec, lease);
    // All-or-nothing: build the new structures first, then swap.
    const items = new Map(rec.items);
    for (const row of batch.upserts) items.set(row.identity, clone(row));
    for (const id of batch.deletes) items.delete(id);
    const outbox = new Map(rec.outbox);
    for (const row of batch.events) outbox.set(row.eventId, clone(row));
    const parked = new Map(rec.parked);
    for (const row of batch.parked ?? []) parked.set(row.id, clone(row));
    const log = batch.log
      ? rec.log.concat(
          batch.events.map((r) => ({
            sequence: r.sequence,
            event: clone(r.event),
            createdAt: r.createdAt,
          })),
        )
      : rec.log;
    this.applyPatch(rec, batch.statePatch);
    rec.items = items;
    rec.outbox = outbox;
    rec.parked = parked;
    rec.log = log;
  }

  async loadPending(key: PKey, limit: number): Promise<OutboxRow[]> {
    const rec = this.peek(key);
    if (!rec) return [];
    return Array.from(rec.outbox.values())
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(clone);
  }

  async countPending(key: PKey): Promise<number> {
    let n = 0;
    for (const r of this.peek(key)?.outbox.values() ?? []) if (r.status === 'pending') n++;
    return n;
  }

  async ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void> {
    const rec = this.record(key);
    this.fence(key, rec, lease);
    for (const id of eventIds) rec.outbox.delete(id);
  }

  async recordAttempt(
    key: PKey,
    lease: Lease,
    eventId: string,
    error: OutboxRow['lastError'],
    nextAttemptAt: number | null,
  ): Promise<void> {
    const rec = this.record(key);
    this.fence(key, rec, lease);
    const row = rec.outbox.get(eventId);
    if (!row) return;
    row.attempts += 1;
    row.lastError = error ? clone(error) : null;
    row.nextAttemptAt = nextAttemptAt;
  }

  async parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void> {
    const rec = this.record(key);
    this.fence(key, rec, lease);
    rec.parked.set(row.id, clone(row));
    if (row.event) rec.outbox.delete(row.event.id);
  }

  async listParked(
    key: PKey,
    opts: { kind?: 'poison' | 'invalid'; limit?: number } = {},
  ): Promise<ParkedRow[]> {
    const rows = Array.from(this.peek(key)?.parked.values() ?? [])
      .filter((r) => opts.kind === undefined || r.kind === opts.kind)
      .sort((a, b) => a.parkedAt - b.parkedAt);
    return rows.slice(0, opts.limit ?? rows.length).map(clone);
  }

  async countParked(key: PKey): Promise<number> {
    return this.peek(key)?.parked.size ?? 0;
  }

  async retryParked(key: PKey, ids: string[]): Promise<number> {
    const rec = this.peek(key);
    if (!rec) return 0;
    let n = 0;
    for (const id of ids) {
      const row = rec.parked.get(id);
      if (!row || row.kind !== 'poison' || !row.event) continue;
      rec.outbox.set(row.event.id, {
        eventId: row.event.id,
        sequence: row.event.sequence,
        event: clone(row.event),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        createdAt: row.parkedAt,
      });
      rec.parked.delete(id);
      n++;
    }
    return n;
  }

  async discardParked(key: PKey, ids: string[]): Promise<number> {
    const rec = this.peek(key);
    if (!rec) return 0;
    let n = 0;
    for (const id of ids) if (rec.parked.delete(id)) n++;
    return n;
  }

  async heldKeys(key: PKey): Promise<Set<string>> {
    const out = new Set<string>();
    for (const r of this.peek(key)?.parked.values() ?? [])
      if (r.holdKey !== null) out.add(r.holdKey);
    return out;
  }

  async getValidator(key: PKey, urlHash: string): Promise<Validator | null> {
    const v = this.peek(key)?.validators.get(urlHash);
    return v ? clone(v) : null;
  }

  async setValidator(
    key: PKey,
    lease: Lease,
    urlHash: string,
    validator: Validator,
  ): Promise<void> {
    const rec = this.record(key);
    this.fence(key, rec, lease);
    rec.validators.set(urlHash, clone(validator));
  }

  async readLog(
    key: PKey,
    range: { afterSequence?: number; fromTime?: number; toTime?: number },
    limit: number,
  ): Promise<LoggedEvent[]> {
    return (this.peek(key)?.log ?? [])
      .filter(
        (e) =>
          (range.afterSequence === undefined || e.sequence > range.afterSequence) &&
          (range.fromTime === undefined || e.createdAt >= range.fromTime) &&
          (range.toTime === undefined || e.createdAt <= range.toTime),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, limit)
      .map(clone);
  }

  async pruneLog(key: PKey, olderThan: number): Promise<number> {
    const rec = this.peek(key);
    if (!rec) return 0;
    const before = rec.log.length;
    rec.log = rec.log.filter((e) => e.createdAt >= olderThan);
    return before - rec.log.length;
  }

  /** Test helper: total rows across all keys, for leak checks. */
  debugSize(): { keys: number; items: number; outbox: number; parked: number; log: number } {
    let items = 0;
    let outbox = 0;
    let parked = 0;
    let log = 0;
    for (const r of this.records.values()) {
      items += r.items.size;
      outbox += r.outbox.size;
      parked += r.parked.size;
      log += r.log.length;
    }
    return { keys: this.records.size, items, outbox, parked, log };
  }
}
