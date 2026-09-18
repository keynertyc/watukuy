import type { ResolvedPoller } from '../core/poller-types.ts';
import type { ItemRow } from '../core/store-types.ts';
import { fingerprintOf } from './hash.ts';

/** One validated item with everything the diff needs: identity, version, and fingerprint hash. */
export interface DiffCandidate {
  identity: string;
  item: unknown;
  /** `String(poller.version(item))`, or `null` when the poller has no version selector. */
  version: string | null;
  /** Fingerprint hash (see {@link fingerprintOf}). */
  hash: string;
}

/** A detected change. `deleted` is produced separately by {@link detectDeletes}. */
export interface Change {
  type: 'created' | 'updated';
  identity: string;
  item: unknown;
  /** The previously stored payload; only set for `updated` with `retain: 'payload'`. */
  previous: unknown | undefined;
  version: string | null;
  hash: string;
}

export interface DiffResult {
  /** Events to emit, in candidate order. */
  changes: Change[];
  /** Rows to write in the same commit: every created, updated, rebaselined, or touched item. */
  upserts: ItemRow[];
  /** Identities whose fingerprint (and schema version) matched the stored row. */
  unchanged: string[];
  /**
   * Identities whose stored row had a different `schemaVersion` and was rewritten without an
   * event: every drifted row under `onSchemaChange: 'rebaseline'`, and rows whose hash did not
   * change under `'emit'`.
   */
  rebaselined: string[];
}

/** Coerce whatever `identity()` returned into the string the store keys on. */
function identityOf(poller: ResolvedPoller, item: unknown): string {
  const id: unknown = poller.identity(item as never);
  if (typeof id === 'string') return id;
  if (typeof id === 'number' || typeof id === 'bigint') return String(id);
  throw new TypeError(
    `poller '${poller.name}': identity() must return a string, got ${id === null ? 'null' : typeof id}`,
  );
}

/**
 * Compute identity, version, and hash for a page of validated items.
 *
 * - `version` is `String(poller.version(item))` when a version selector exists, else `null`.
 * - **Version fast path** (PLAN §5.3): when `version` is non-null and the stored row has the same
 *   `version` and the same `schemaVersion`, the item is reported in `unchanged` without being
 *   hashed and is *not* a candidate. Callers tracking presence (snapshotDiff, reconcile) must
 *   union this list with `DiffResult.unchanged`.
 * - **Duplicate identities** inside `items` (possible with `overlap` re-scans or an API that
 *   repeats rows across pages): the *last* occurrence wins; the candidate keeps the position of
 *   the first occurrence.
 *
 * Hashing happens in `items` order, one at a time, so results are deterministic.
 */
export async function prepareCandidates(
  poller: ResolvedPoller,
  items: unknown[],
  existing: Map<string, ItemRow>,
): Promise<{ candidates: DiffCandidate[]; unchanged: string[] }> {
  const latest = new Map<string, unknown>();
  for (const item of items) latest.set(identityOf(poller, item), item);

  const candidates: DiffCandidate[] = [];
  const unchanged: string[] = [];
  for (const [identity, item] of latest) {
    const version = poller.version ? String(poller.version(item as never)) : null;
    const row = existing.get(identity);
    if (
      version !== null &&
      row !== undefined &&
      row.version === version &&
      row.schemaVersion === poller.schemaVersion
    ) {
      unchanged.push(identity);
      continue;
    }
    const hash = await fingerprintOf(poller, item);
    candidates.push({ identity, item, version, hash });
  }
  return { candidates, unchanged };
}

function rowFor(poller: ResolvedPoller, candidate: DiffCandidate, now: number): ItemRow {
  const row: ItemRow = {
    identity: candidate.identity,
    version: candidate.version,
    hash: candidate.hash,
    schemaVersion: poller.schemaVersion,
    seenAt: now,
  };
  if (poller.retain === 'payload') row.payload = candidate.item;
  return row;
}

/**
 * Compare candidates against the stored rows and decide what changed (PLAN §5.3).
 *
 * | stored row | condition | result |
 * |---|---|---|
 * | absent | – | `created`, upsert |
 * | present, same `schemaVersion` | hash differs | `updated`, upsert (`previous` = stored payload with `retain: 'payload'`) |
 * | present, same `schemaVersion` | hash equal | `unchanged`; upsert only with `touchUnchanged` or when the version string changed |
 * | present, other `schemaVersion` | `onSchemaChange: 'rebaseline'` | `rebaselined`, upsert, **no event** |
 * | present, other `schemaVersion` | `onSchemaChange: 'emit'` | `updated` when the hash differs, otherwise `rebaselined`; upsert either way |
 *
 * Upserts carry `payload` only when `poller.retain === 'payload'`, and always `seenAt = now`.
 * `touchUnchanged` (default `false`) additionally upserts unchanged rows with a refreshed
 * `seenAt`; `snapshotDiff` uses it to record presence.
 */
export function diffCandidates(
  poller: ResolvedPoller,
  candidates: DiffCandidate[],
  existing: Map<string, ItemRow>,
  opts: { now: number; touchUnchanged?: boolean },
): DiffResult {
  const touch = opts.touchUnchanged === true;
  const result: DiffResult = { changes: [], upserts: [], unchanged: [], rebaselined: [] };

  for (const candidate of candidates) {
    const row = existing.get(candidate.identity);

    if (row === undefined) {
      result.changes.push({
        type: 'created',
        identity: candidate.identity,
        item: candidate.item,
        previous: undefined,
        version: candidate.version,
        hash: candidate.hash,
      });
      result.upserts.push(rowFor(poller, candidate, opts.now));
      continue;
    }

    const drifted = row.schemaVersion !== poller.schemaVersion;
    if (drifted && poller.onSchemaChange === 'rebaseline') {
      result.rebaselined.push(candidate.identity);
      result.upserts.push(rowFor(poller, candidate, opts.now));
      continue;
    }

    if (row.hash !== candidate.hash) {
      result.changes.push({
        type: 'updated',
        identity: candidate.identity,
        item: candidate.item,
        previous: poller.retain === 'payload' ? row.payload : undefined,
        version: candidate.version,
        hash: candidate.hash,
      });
      result.upserts.push(rowFor(poller, candidate, opts.now));
      continue;
    }

    if (drifted) {
      // 'emit' with an identical hash: nothing to tell the handler, but the row must move to the
      // current schemaVersion so the version fast path applies again.
      result.rebaselined.push(candidate.identity);
      result.upserts.push(rowFor(poller, candidate, opts.now));
      continue;
    }

    result.unchanged.push(candidate.identity);
    if (touch || row.version !== candidate.version) {
      result.upserts.push(rowFor(poller, candidate, opts.now));
    }
  }

  return result;
}

/**
 * Identities present in the stored snapshot but absent from the identities seen in this cycle,
 * i.e. the items to emit `deleted` for. Sorted by UTF-16 code units for determinism.
 */
export function detectDeletes(existing: Iterable<string>, seen: ReadonlySet<string>): string[] {
  const deleted: string[] = [];
  for (const identity of existing) {
    if (!seen.has(identity)) deleted.push(identity);
  }
  return deleted.sort();
}
