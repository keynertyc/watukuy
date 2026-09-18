import type { EventType } from '../core/event.ts';
import { sha256Hex } from '../core/hash.ts';

/** The fields that make an event id unique (see docs/cursors.md, guarantee G2). */
export interface EventIdParts {
  /** Event `source` (`urn:watukuy:<poller>` unless overridden). */
  source: string;
  /** Partition key, `''` for single-partition pollers. */
  partition: string;
  /** Item identity. */
  identity: string;
  /**
   * The item's `version` when the poller declares one, otherwise its fingerprint hash. For
   * `deleted` events pass the last stored version-or-hash.
   */
  version: string;
  /** `schemaVersion` of the poller that produced the event. */
  schemaVersion: number;
  type: EventType;
}

/** Versioned prefix so a future change of the material layout can never collide with v1 ids. */
const PREFIX = 'watukuy|v1|';

/** Escape the separator and the escape character inside one part. */
function escapePart(part: string): string {
  return part.replace(/[\\|]/g, (c) => `\\${c}`);
}

/**
 * The exact string that is hashed by {@link eventId}. Exposed for debugging and for independent
 * implementations that need to reproduce ids.
 *
 * Layout: `watukuy|v1|<source>|<partition>|<identity>|<version>|<schemaVersion>|<type>` where
 * every `|` and `\` inside a part is escaped with a backslash, so `('a|b', 'c')` and
 * `('a', 'b|c')` never produce the same material.
 */
export function eventIdMaterial(parts: EventIdParts): string {
  return (
    PREFIX +
    [
      parts.source,
      parts.partition,
      parts.identity,
      parts.version,
      String(parts.schemaVersion),
      parts.type,
    ]
      .map(escapePart)
      .join('|')
  );
}

/**
 * Deterministic event id: SHA-256 (hex) of {@link eventIdMaterial}. The same change observed
 * twice (crash before ack, overlap re-scan, replay) yields the same id, so consumers can
 * deduplicate (guarantee G2).
 *
 * @example
 * await eventId({ source: 'urn:watukuy:orders', partition: '', identity: 'o1', version: 'v1', schemaVersion: 1, type: 'created' });
 * // '5dc9ec28d4ec668a7add37c6a32e916f839cd6d98ee013de30acd06b32599862'
 */
export async function eventId(parts: EventIdParts): Promise<string> {
  return sha256Hex(eventIdMaterial(parts));
}
