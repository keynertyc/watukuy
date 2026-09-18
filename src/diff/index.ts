/**
 * Change engine: RFC 8785 canonicalization, fingerprint hashing, deterministic event ids, and the
 * create/update/delete diff against the stored snapshot (see docs/cursors.md).
 * @module
 */

export { canonicalize } from './canonicalize.ts';
export {
  type Change,
  type DiffCandidate,
  type DiffResult,
  detectDeletes,
  diffCandidates,
  prepareCandidates,
} from './diff.ts';
export { type EventIdParts, eventId, eventIdMaterial } from './event-id.ts';
export { fingerprintOf, hashValue } from './hash.ts';
