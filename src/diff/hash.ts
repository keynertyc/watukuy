import { sha256Hex } from '../core/hash.ts';
import type { ResolvedPoller } from '../core/poller-types.ts';
import { canonicalize } from './canonicalize.ts';

/**
 * Content hash of any JSON-representable value: SHA-256 (hex) over its RFC 8785 canonical form.
 * Two values that differ only in key order, whitespace, or number formatting hash identically.
 *
 * @throws {TypeError} when the value cannot be canonicalized (see {@link canonicalize}).
 */
export async function hashValue(value: unknown): Promise<string> {
  return sha256Hex(canonicalize(value));
}

/**
 * The fingerprint hash of one validated item for `poller`: hashes `poller.fingerprint(item)` when
 * a fingerprint selector is configured, otherwise the whole item (PLAN §5.3).
 */
export async function fingerprintOf(poller: ResolvedPoller, item: unknown): Promise<string> {
  const subject = poller.fingerprint ? poller.fingerprint(item as never) : item;
  return hashValue(subject);
}
