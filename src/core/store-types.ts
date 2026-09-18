import type { RateLimitInfo, SerializedError } from './errors.ts';
import type { WatukuyEvent } from './event.ts';
import type { Lane, PollSummary } from './poller-types.ts';

export interface PKey {
  poller: string;
  partition: string;
}

export interface Lease {
  owner: string;
  /** Monotonic fencing token; every write carries it and stores reject stale values (PLAN §5.5). */
  epoch: number;
  expiresAt: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ScheduleState {
  nextDueAt: number | null;
  intervalMs: number | null;
  consecutiveFailures: number;
  circuit: CircuitState;
  circuitOpenedAt: number | null;
  /** Epoch ms until which the API asked us to back off (`Retry-After`). */
  throttledUntil: number | null;
  rateLimit: RateLimitInfo | null;
  lastPollAt: number | null;
  lastPoll: PollSummary | null;
  lastError: SerializedError | null;
}

export interface LaneCursor {
  /** Serialized cursor (JSON). `null` before the first poll. */
  cursor: string | null;
  /** Backfill only: serialized stop cursor. */
  target?: string | null;
  /** Reconcile / backfill: `true` once finished. */
  done?: boolean;
  /** Reconcile: last completed run. */
  lastRunAt?: number | null;
  /** Backfill only: re-emit even when identity/version is already known. */
  force?: boolean;
}

export interface PollerState {
  lanes: Partial<Record<Lane, LaneCursor>>;
  schedule: ScheduleState;
  paused: boolean;
  /** Schema version of the stored item rows. */
  schemaVersion: number | null;
  /** Last assigned outbox sequence. */
  sequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface ItemRow {
  identity: string;
  version: string | null;
  hash: string;
  schemaVersion: number;
  payload?: unknown;
  seenAt: number;
}

export type OutboxStatus = 'pending' | 'delivered';

export interface OutboxRow {
  eventId: string;
  sequence: number;
  event: WatukuyEvent<unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: SerializedError | null;
  createdAt: number;
}

export interface ParkedError extends SerializedError {
  history?: Array<{ at: number; message: string }>;
  issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>;
}

export interface ParkedRow {
  id: string;
  kind: 'poison' | 'invalid';
  /** Present for `poison`. */
  event: WatukuyEvent<unknown> | null;
  /** Present for `invalid`: the raw item. */
  item: unknown;
  error: ParkedError;
  attempts: number;
  parkedAt: number;
  /** Ordering key held while parked (`holdKey: true`). */
  holdKey: string | null;
}

export interface Validator {
  etag: string | null;
  lastModified: string | null;
  storedAt: number;
}

export interface LoggedEvent {
  sequence: number;
  event: WatukuyEvent<unknown>;
  createdAt: number;
}

/** Everything a poll produces, committed in ONE transaction (PLAN G4). */
export interface CommitBatch {
  statePatch: Partial<Omit<PollerState, 'createdAt'>>;
  upserts: ItemRow[];
  deletes: string[];
  events: OutboxRow[];
  /** Also append to the event log when the poller has one. */
  log: boolean;
  /** Parked rows written in the same transaction (invalid items quarantined during this page). */
  parked?: ParkedRow[] | undefined;
}

export interface StoreCapabilities {
  transactions: boolean;
  log: boolean;
  streaming: boolean;
}

/**
 * Durability port (PLAN §6). Implementations: `MemoryStore`, `SqliteStore`, `PostgresStore`,
 * `RedisStore`. Certify a custom store with `storeContractSuite()` from `watukuy/testing`.
 *
 * Every mutating method takes the current `Lease` and must reject with `LeaseLostError` when the
 * stored epoch differs.
 */
export interface StateStore {
  readonly capabilities: StoreCapabilities;
  migrate(): Promise<void>;
  close(): Promise<void>;

  acquireLease(key: PKey, owner: string, ttlMs: number, now: number): Promise<Lease | null>;
  renewLease(key: PKey, lease: Lease, ttlMs: number, now: number): Promise<boolean>;
  releaseLease(key: PKey, lease: Lease): Promise<void>;
  /** Current lease holder, for `inspect()`. */
  getLease(key: PKey): Promise<Lease | null>;

  loadState(key: PKey): Promise<PollerState | null>;
  saveState(key: PKey, lease: Lease, patch: Partial<Omit<PollerState, 'createdAt'>>): Promise<void>;
  /** Administrative write without a lease (pause/resume/reset from the CLI). */
  saveStateUnfenced(key: PKey, patch: Partial<Omit<PollerState, 'createdAt'>>): Promise<void>;
  listKeys(poller?: string): Promise<PKey[]>;
  /** Remove every row for the key: state, lease, items, outbox, parked, validators, log. */
  deleteKey(key: PKey): Promise<void>;
  /** Drop the item snapshot only (administrative, `resetCursor({ clearSnapshot: true })`). */
  clearItems(key: PKey): Promise<void>;

  loadVersions(key: PKey, identities: string[]): Promise<Map<string, ItemRow>>;
  streamIdentities(key: PKey, batchSize?: number): AsyncIterable<string[]>;
  countItems(key: PKey): Promise<number>;

  commitPoll(key: PKey, lease: Lease, batch: CommitBatch): Promise<void>;
  /**
   * Pending outbox rows in `sequence` order, regardless of `nextAttemptAt` (the dispatcher decides
   * when a row is eligible so per-key ordering is preserved).
   */
  loadPending(key: PKey, limit: number): Promise<OutboxRow[]>;
  countPending(key: PKey): Promise<number>;
  ackEvents(key: PKey, lease: Lease, eventIds: string[]): Promise<void>;
  recordAttempt(
    key: PKey,
    lease: Lease,
    eventId: string,
    error: SerializedError,
    nextAttemptAt: number | null,
  ): Promise<void>;
  parkEvent(key: PKey, lease: Lease, row: ParkedRow): Promise<void>;
  listParked(
    key: PKey,
    opts?: { kind?: 'poison' | 'invalid'; limit?: number },
  ): Promise<ParkedRow[]>;
  countParked(key: PKey): Promise<number>;
  /** Move parked poison events back to the outbox as pending. */
  retryParked(key: PKey, ids: string[]): Promise<number>;
  discardParked(key: PKey, ids: string[]): Promise<number>;
  /** Ordering keys currently held by parked events (`holdKey: true`). */
  heldKeys(key: PKey): Promise<Set<string>>;

  getValidator(key: PKey, urlHash: string): Promise<Validator | null>;
  setValidator(key: PKey, lease: Lease, urlHash: string, validator: Validator): Promise<void>;

  readLog(
    key: PKey,
    range: { afterSequence?: number; fromTime?: number; toTime?: number },
    limit: number,
  ): Promise<LoggedEvent[]>;
  pruneLog(key: PKey, olderThan: number): Promise<number>;
}

export interface BudgetPolicy {
  requests: number;
  /** Window in milliseconds. */
  perMs: number;
  /** Max tokens accumulated. @default requests */
  burst: number;
}

/** Shared token bucket port (PLAN §5.7). In-memory by default; `RedisBudgetStore` for cross-instance budgets. */
export interface RateBudgetStore {
  take(
    name: string,
    cost: number,
    policy: BudgetPolicy,
    now: number,
  ): Promise<{ ok: true; remaining: number } | { ok: false; retryInMs: number }>;
  /** Tokens currently available, for metrics. */
  peek(name: string, policy: BudgetPolicy, now: number): Promise<number>;
}
