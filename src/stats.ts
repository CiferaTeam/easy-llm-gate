import { redis } from "./redis.js";
import { getUpstreamKey } from "./store.js";

/**
 * Traffic stats module.
 *
 * In-memory counters accumulate per 5-second window, then flush to Redis
 * sorted sets. Each upstream key gets one sorted set keyed by
 * `stats:{upstream_key_id}` with score = epoch-seconds (rounded to 5s).
 *
 * Data is kept for 30 days via periodic pruning.
 */

const SNAPSHOT_INTERVAL_MS = 5_000; // 5 seconds
const RETENTION_SEC = 30 * 24 * 60 * 60; // 30 days

// ── In-memory counters ──

interface GateCounter {
  rpm: number;
  tpm: number;
}

interface KeyCounter {
  rpm: number;
  tpm: number;
  byGate: Map<string, GateCounter>;
}

const counters = new Map<string, KeyCounter>();

/** Record one request passing through an upstream key from a gate key. */
export function recordRequest(
  upstreamKeyId: string,
  gateKeyId: string,
  tokens: number
) {
  let kc = counters.get(upstreamKeyId);
  if (!kc) {
    kc = { rpm: 0, tpm: 0, byGate: new Map() };
    counters.set(upstreamKeyId, kc);
  }
  kc.rpm++;
  kc.tpm += tokens;

  let gc = kc.byGate.get(gateKeyId);
  if (!gc) {
    gc = { rpm: 0, tpm: 0 };
    kc.byGate.set(gateKeyId, gc);
  }
  gc.rpm++;
  gc.tpm += tokens;
}

// ── Snapshot data shape (stored as JSON in Redis sorted set member) ──

export interface TrafficSnapshot {
  ts: number; // epoch seconds, rounded to 5s
  rpmLimit: number;
  rpmActual: number;
  rpmByGate: Record<string, number>;
  tpmLimit: number;
  tpmActual: number;
  tpmByGate: Record<string, number>;
}

// ── Flush counters to Redis ──

async function flush() {
  const now = Math.floor(Date.now() / 1000);
  const ts = now - (now % 5); // round to 5-second boundary

  for (const [ukId, kc] of counters) {
    // Look up limits from DB
    const uk = await getUpstreamKey(ukId);
    const rpmLimit = uk?.rpm_limit ?? 0;
    const tpmLimit = uk?.tpm_limit ?? 0;

    const rpmByGate: Record<string, number> = {};
    const tpmByGate: Record<string, number> = {};
    for (const [gkId, gc] of kc.byGate) {
      rpmByGate[gkId] = gc.rpm;
      tpmByGate[gkId] = gc.tpm;
    }

    const snapshot: TrafficSnapshot = {
      ts,
      rpmLimit,
      rpmActual: kc.rpm,
      rpmByGate,
      tpmLimit,
      tpmActual: kc.tpm,
      tpmByGate,
    };

    const redisKey = `stats:${ukId}`;
    // Use ts as score and JSON as member.
    // To allow multiple snapshots at the same ts (shouldn't happen, but safe):
    // we remove any existing member at this score first.
    await redis
      .multi()
      .zremrangebyscore(redisKey, ts, ts)
      .zadd(redisKey, ts, JSON.stringify(snapshot))
      .exec();
  }

  // Reset counters
  counters.clear();
}

// ── Prune old data (run once per hour) ──

async function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SEC;
  // Scan all stats:* keys
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "stats:*", "COUNT", 100);
    cursor = next;
    for (const key of keys) {
      await redis.zremrangebyscore(key, "-inf", cutoff);
    }
  } while (cursor !== "0");
}

// ── Query ──

export async function getTrafficSnapshots(
  upstreamKeyId: string,
  fromTs: number,
  toTs: number
): Promise<TrafficSnapshot[]> {
  const redisKey = `stats:${upstreamKeyId}`;
  const members = await redis.zrangebyscore(redisKey, fromTs, toTs);
  return members.map((m) => JSON.parse(m) as TrafficSnapshot);
}

/** List all upstream key IDs that have stats data. */
export async function getStatsUpstreamKeyIds(): Promise<string[]> {
  const ids: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "stats:*", "COUNT", 100);
    cursor = next;
    for (const key of keys) {
      ids.push(key.replace("stats:", ""));
    }
  } while (cursor !== "0");
  return [...new Set(ids)];
}

// ── Lifecycle ──

let flushTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function startStats() {
  flushTimer = setInterval(() => {
    flush().catch((err) => console.error("[stats] flush error:", err.message));
  }, SNAPSHOT_INTERVAL_MS);

  // Prune once per hour
  pruneTimer = setInterval(() => {
    prune().catch((err) => console.error("[stats] prune error:", err.message));
  }, 60 * 60 * 1000);

  console.log("[stats] started (5s snapshots, 30d retention)");
}

export function stopStats() {
  if (flushTimer) clearInterval(flushTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  flushTimer = null;
  pruneTimer = null;
}
