import { emptyPollerState } from '../memory/memory-store.ts';

/**
 * Lua scripts for `RedisStore` and `RedisBudgetStore`. Each fenced write is a single `EVAL` so the
 * epoch check and the multi-key mutation are atomic (PLAN §5.5, §6). Scripts never decode user
 * JSON with `cjson`: every payload travels as an opaque string, so payload arrays, large integers
 * and unicode round-trip byte-for-byte.
 *
 * Sentinel replies: `'LEASE_LOST'` when `lease_owner` / `lease_epoch` differ from the caller's
 * lease, `'OK'` otherwise.
 */

/** Reply returned by fenced scripts when the caller's lease is stale. */
export const LEASE_LOST = 'LEASE_LOST';

/** Field names of the per-key state hash; each holds one JSON-encoded top-level `PollerState` field. */
export const STATE_FIELDS = [
  'lanes',
  'schedule',
  'paused',
  'schemaVersion',
  'sequence',
  'createdAt',
  'updatedAt',
] as const;

const ZERO = emptyPollerState(0);

/** `KEYS[1]` must be the meta hash, `ARGV[1]` the owner and `ARGV[2]` the epoch. */
const FENCE = `
local function fenced()
  return redis.call('HGET', KEYS[1], 'lease_owner') == ARGV[1]
    and redis.call('HGET', KEYS[1], 'lease_epoch') == ARGV[2]
end
`;

/**
 * Overlay `n` field/value pairs starting at `ARGV[from]` (count first) onto the state hash, creating
 * the zero state first when the key has never been saved (`createdAt = updatedAt = now0`).
 * Returns the ARGV index following the segment.
 */
const APPLY_STATE = `
local function apply_state(skey, now0, from)
  if redis.call('EXISTS', skey) == 0 then
    redis.call('HSET', skey,
      'lanes', '{}',
      'schedule', ${luaString(JSON.stringify(ZERO.schedule))},
      'paused', 'false',
      'schemaVersion', 'null',
      'sequence', '0',
      'createdAt', now0,
      'updatedAt', now0)
  end
  local n = tonumber(ARGV[from])
  for i = 1, n do
    local field = ARGV[from + 2 * i - 1]
    if field ~= 'createdAt' then
      redis.call('HSET', skey, field, ARGV[from + 2 * i])
    end
  end
  return from + 1 + 2 * n
end
`;

/** Remove every trace of an outbox row: pending index, row, attempt counter, last error. */
const DROP_OUTBOX = `
local function drop_outbox(zset, rows, att, err, id)
  redis.call('ZREM', zset, id)
  redis.call('HDEL', rows, id)
  redis.call('HDEL', att, id)
  redis.call('HDEL', err, id)
end
`;

/**
 * KEYS: meta, keysSet. ARGV: owner, now, expiresAt, keyMember.
 * Returns the new epoch as a string, or `false` (nil) when another owner holds an unexpired lease.
 */
export const ACQUIRE_LEASE = `
local owner = redis.call('HGET', KEYS[1], 'lease_owner')
if owner and owner ~= ARGV[1] then
  local expires = tonumber(redis.call('HGET', KEYS[1], 'lease_expires_at'))
  if expires and expires > tonumber(ARGV[2]) then return false end
end
local epoch = redis.call('HINCRBY', KEYS[1], 'epoch_counter', 1)
redis.call('HSET', KEYS[1],
  'lease_owner', ARGV[1],
  'lease_epoch', tostring(epoch),
  'lease_expires_at', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
return tostring(epoch)
`;

/** KEYS: meta. ARGV: owner, epoch, expiresAt. Returns 1 when renewed, 0 when the lease is stale. */
export const RENEW_LEASE = `${FENCE}
if not fenced() then return 0 end
redis.call('HSET', KEYS[1], 'lease_expires_at', ARGV[3])
return 1
`;

/** KEYS: meta. ARGV: owner, epoch. Clears the lease only when it is still ours. */
export const RELEASE_LEASE = `${FENCE}
if fenced() then
  redis.call('HDEL', KEYS[1], 'lease_owner', 'lease_epoch', 'lease_expires_at')
end
return 1
`;

/** KEYS: meta, state, keysSet. ARGV: owner, epoch, keyMember, now0, n, field, value, ... */
export const SAVE_STATE = `${FENCE}${APPLY_STATE}
if not fenced() then return '${LEASE_LOST}' end
apply_state(KEYS[2], ARGV[4], 5)
redis.call('SADD', KEYS[3], ARGV[3])
return 'OK'
`;

/** KEYS: state, keysSet. ARGV: keyMember, now0, n, field, value, ... */
export const SAVE_STATE_UNFENCED = `${APPLY_STATE}
apply_state(KEYS[1], ARGV[2], 3)
redis.call('SADD', KEYS[2], ARGV[1])
return 'OK'
`;

/**
 * KEYS: meta, state, items, outbox, rows, attempts, errors, parked, hold, log, keysSet.
 * ARGV: owner, epoch, keyMember, now0,
 *   nState, (field, value)...,
 *   nUpserts, (identity, json)...,
 *   nDeletes, identity...,
 *   nEvents, (eventId, sequence, status, rowJson, loggedJson | '')...,
 *   nParked, (id, json, hasHold '1'|'0', holdKey)...
 */
export const COMMIT_POLL = `${FENCE}${APPLY_STATE}
if not fenced() then return '${LEASE_LOST}' end
local i = apply_state(KEYS[2], ARGV[4], 5)
local n = tonumber(ARGV[i]); i = i + 1
for _ = 1, n do
  redis.call('HSET', KEYS[3], ARGV[i], ARGV[i + 1])
  i = i + 2
end
n = tonumber(ARGV[i]); i = i + 1
for _ = 1, n do
  redis.call('HDEL', KEYS[3], ARGV[i])
  i = i + 1
end
n = tonumber(ARGV[i]); i = i + 1
for _ = 1, n do
  local id, seq, status, row, logged = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3], ARGV[i + 4]
  i = i + 5
  redis.call('HSET', KEYS[5], id, row)
  redis.call('HDEL', KEYS[6], id)
  redis.call('HDEL', KEYS[7], id)
  if status == 'pending' then
    redis.call('ZADD', KEYS[4], seq, id)
  else
    redis.call('ZREM', KEYS[4], id)
  end
  if logged ~= '' then redis.call('ZADD', KEYS[10], seq, logged) end
end
n = tonumber(ARGV[i]); i = i + 1
for _ = 1, n do
  local id, row, hasHold, hold = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
  i = i + 4
  redis.call('HSET', KEYS[8], id, row)
  if hasHold == '1' then
    redis.call('HSET', KEYS[9], id, hold)
  else
    redis.call('HDEL', KEYS[9], id)
  end
end
redis.call('SADD', KEYS[11], ARGV[3])
return 'OK'
`;

/** KEYS: meta, outbox, rows, attempts, errors. ARGV: owner, epoch, eventId... */
export const ACK_EVENTS = `${FENCE}${DROP_OUTBOX}
if not fenced() then return '${LEASE_LOST}' end
for i = 3, #ARGV do
  drop_outbox(KEYS[2], KEYS[3], KEYS[4], KEYS[5], ARGV[i])
end
return 'OK'
`;

/** KEYS: meta, rows, attempts, errors. ARGV: owner, epoch, eventId, errorJson. No-op for unknown ids. */
export const RECORD_ATTEMPT = `${FENCE}
if not fenced() then return '${LEASE_LOST}' end
if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then
  redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
  redis.call('HSET', KEYS[4], ARGV[3], ARGV[4])
end
return 'OK'
`;

/**
 * KEYS: meta, parked, hold, outbox, rows, attempts, errors, keysSet.
 * ARGV: owner, epoch, keyMember, id, json, hasHold '1'|'0', holdKey, hasEvent '1'|'0', eventId.
 */
export const PARK_EVENT = `${FENCE}${DROP_OUTBOX}
if not fenced() then return '${LEASE_LOST}' end
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
if ARGV[6] == '1' then
  redis.call('HSET', KEYS[3], ARGV[4], ARGV[7])
else
  redis.call('HDEL', KEYS[3], ARGV[4])
end
if ARGV[8] == '1' then
  drop_outbox(KEYS[4], KEYS[5], KEYS[6], KEYS[7], ARGV[9])
end
redis.call('SADD', KEYS[8], ARGV[3])
return 'OK'
`;

/** KEYS: meta, validators, keysSet. ARGV: owner, epoch, keyMember, urlHash, json. */
export const SET_VALIDATOR = `${FENCE}
if not fenced() then return '${LEASE_LOST}' end
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
redis.call('SADD', KEYS[3], ARGV[3])
return 'OK'
`;

/**
 * KEYS: parked, hold, outbox, rows, attempts, errors. ARGV: n, (parkedId, eventId, sequence, rowJson)...
 * Re-inserts each still-parked row as a fresh pending outbox row. Returns the number moved.
 */
export const RETRY_PARKED = `
local moved = 0
local n = tonumber(ARGV[1])
local i = 2
for _ = 1, n do
  local pid, eid, seq, row = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
  i = i + 4
  if redis.call('HEXISTS', KEYS[1], pid) == 1 then
    redis.call('HSET', KEYS[4], eid, row)
    redis.call('HDEL', KEYS[5], eid)
    redis.call('HDEL', KEYS[6], eid)
    redis.call('ZADD', KEYS[3], seq, eid)
    redis.call('HDEL', KEYS[1], pid)
    redis.call('HDEL', KEYS[2], pid)
    moved = moved + 1
  end
end
return moved
`;

/** KEYS: parked, hold. ARGV: id... Returns the number of parked rows removed. */
export const DISCARD_PARKED = `
local removed = 0
for i = 1, #ARGV do
  removed = removed + redis.call('HDEL', KEYS[1], ARGV[i])
  redis.call('HDEL', KEYS[2], ARGV[i])
end
return removed
`;

/**
 * Token bucket mirroring `MemoryBudgetStore` exactly (scaled token-milliseconds, same epsilon,
 * same clamping rules), driven by the caller's `now` so it is deterministic under a fake clock.
 *
 * KEYS: bucket hash {scaled, updated_at}. ARGV: cost, requests, perMs, burst, now.
 * Returns `{'1', remaining}` or `{'0', retryInMs}` as `%.17g` strings (exact doubles).
 */
export const BUDGET_TAKE = `
local EPS = 1e-9
local cost = tonumber(ARGV[1])
local requests = tonumber(ARGV[2])
local perMs = tonumber(ARGV[3])
local burst = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

local function refill(capacityTokens)
  local cap = capacityTokens * perMs
  local scaled = redis.call('HGET', KEYS[1], 'scaled')
  local updated = redis.call('HGET', KEYS[1], 'updated_at')
  if not scaled then
    return math.min(cap, burst * perMs), now
  end
  scaled = tonumber(scaled)
  updated = tonumber(updated)
  local elapsed = now - updated
  if elapsed > 0 then
    scaled = math.min(cap, scaled + elapsed * requests)
    updated = now
  elseif scaled > cap then
    scaled = cap
  end
  return scaled, updated
end

local function save(scaled, updated)
  redis.call('HSET', KEYS[1],
    'scaled', string.format('%.17g', scaled),
    'updated_at', string.format('%.17g', updated))
end

if not (cost > 0) then
  local scaled, updated = refill(burst)
  save(scaled, updated)
  return {'1', string.format('%.17g', scaled / perMs)}
end

local capacity = math.max(burst, cost)
local scaled, updated = refill(capacity)
local need = cost * perMs
if scaled + EPS >= need then
  scaled = math.max(0, scaled - need)
  save(scaled, updated)
  return {'1', string.format('%.17g', scaled / perMs)}
end
save(scaled, updated)
local deficit = need - scaled
local retry = math.max(1, math.ceil(deficit / requests - EPS))
return {'0', string.format('%.17g', retry)}
`;

/** Quote a JS string as a Lua single-quoted literal. */
function luaString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}
