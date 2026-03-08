import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Prompt Cache Observation Module
 *
 * Tracks request prefix fingerprints per upstream key to observe:
 * 1. Prefix reuse rate (how much of the traffic is repeated system prompts)
 * 2. Actual Anthropic prompt cache hit rate (from response usage fields)
 *
 * Entries have a 10-minute TTL. On expiry, the full messages are persisted
 * to data/prompt_logs/ for offline analysis.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const PREFIX_CHARS = 1024;

// ── Types ──

export interface PromptEntry {
  prefixHash: string;
  /** Full messages array — kept in memory for persistence on expiry */
  messages: any[];
  model: string;
  upstreamKeyId: string;
  gateKeyId: string;
  gateKeyName: string;
  /** First 100 chars of the last user message */
  suffixPreview: string;
  hitCount: number;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface CacheStats {
  /** Per upstream key: tokens that created cache on upstream */
  cacheCreationTokens: number;
  /** Per upstream key: tokens read from upstream cache */
  cacheReadTokens: number;
  /** Total requests observed */
  totalRequests: number;
}

// ── State ──

const entries = new Map<string, PromptEntry>();
const cacheStats = new Map<string, CacheStats>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let logDir = join(process.cwd(), "data", "prompt_logs");

// ── Helpers ──

export function hashPrefix(messages: any[]): string {
  const raw = JSON.stringify(messages);
  const prefix = raw.slice(0, PREFIX_CHARS);
  return createHash("sha256").update(prefix).digest("hex").slice(0, 16);
}

function extractSuffixPreview(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);
      return content.slice(0, 100);
    }
  }
  return "";
}

function persistEntry(entry: PromptEntry) {
  try {
    mkdirSync(logDir, { recursive: true });
    const safeName = entry.gateKeyName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${entry.prefixHash}_${safeName}.json`;
    const data = {
      prefixHash: entry.prefixHash,
      model: entry.model,
      upstreamKeyId: entry.upstreamKeyId,
      gateKeyId: entry.gateKeyId,
      gateKeyName: entry.gateKeyName,
      hitCount: entry.hitCount,
      totalTokens: entry.totalTokens,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      messageCount: entry.messages.length,
      messages: entry.messages,
    };
    writeFileSync(join(logDir, filename), JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error("[prompt-cache] persist error:", err.message);
  }
}

// ── Public API ──

/** Record an incoming prompt request. */
export function recordPrompt(opts: {
  messages: any[];
  model: string;
  upstreamKeyId: string;
  gateKeyId: string;
  gateKeyName: string;
  tokens: number;
}) {
  const hash = hashPrefix(opts.messages);
  // Composite key ensures entries are scoped per upstream key, not globally.
  // Without this, two upstream keys sharing the same prompt prefix would merge
  // into one entry, breaking per-upstream-key statistics.
  const entryKey = `${opts.upstreamKeyId}:${hash}`;
  const now = Date.now();
  const existing = entries.get(entryKey);

  if (existing) {
    existing.messages = opts.messages;
    existing.suffixPreview = extractSuffixPreview(opts.messages);
    existing.hitCount++;
    existing.totalTokens += opts.tokens;
    existing.updatedAt = now;
  } else {
    entries.set(entryKey, {
      prefixHash: hash,
      messages: opts.messages,
      model: opts.model,
      upstreamKeyId: opts.upstreamKeyId,
      gateKeyId: opts.gateKeyId,
      gateKeyName: opts.gateKeyName,
      suffixPreview: extractSuffixPreview(opts.messages),
      hitCount: 1,
      totalTokens: opts.tokens,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Record Anthropic cache usage from response. */
export function recordCacheUsage(
  upstreamKeyId: string,
  cacheCreationTokens: number,
  cacheReadTokens: number
) {
  let stats = cacheStats.get(upstreamKeyId);
  if (!stats) {
    stats = { cacheCreationTokens: 0, cacheReadTokens: 0, totalRequests: 0 };
    cacheStats.set(upstreamKeyId, stats);
  }
  stats.cacheCreationTokens += cacheCreationTokens;
  stats.cacheReadTokens += cacheReadTokens;
  stats.totalRequests++;
}

/** Sweep expired entries — persist then remove. */
export function sweep(now?: number) {
  const ts = now ?? Date.now();
  for (const [hash, entry] of entries) {
    if (ts - entry.updatedAt >= TTL_MS) {
      persistEntry(entry);
      entries.delete(hash);
    }
  }
}

/** Get all live entries (for admin API / UI). */
export function getLiveEntries(): PromptEntry[] {
  return [...entries.values()];
}

/** Get live entries filtered by upstream key. */
export function getLiveEntriesByUpstreamKey(upstreamKeyId: string): PromptEntry[] {
  const result: PromptEntry[] = [];
  for (const entry of entries.values()) {
    if (entry.upstreamKeyId === upstreamKeyId) result.push(entry);
  }
  return result;
}

/** Get cache stats for a specific upstream key. */
export function getCacheStatsForKey(upstreamKeyId: string): CacheStats {
  return cacheStats.get(upstreamKeyId) ?? { cacheCreationTokens: 0, cacheReadTokens: 0, totalRequests: 0 };
}

/** Get cache stats per upstream key. */
export function getCacheStats(): Map<string, CacheStats> {
  return new Map(cacheStats);
}

/** Get prefix reuse rate from live entries. */
export function getPrefixReuseRate(): {
  totalEntries: number;
  totalHits: number;
  reuseRate: number;
} {
  let totalHits = 0;
  for (const entry of entries.values()) {
    totalHits += entry.hitCount;
  }
  const totalEntries = entries.size;
  const reuseRate =
    totalHits > 0 ? 1 - totalEntries / totalHits : 0;
  return { totalEntries, totalHits, reuseRate };
}

// ── Lifecycle ──

export function startPromptCache(opts?: { logDir?: string }) {
  if (opts?.logDir) logDir = opts.logDir;
  sweepTimer = setInterval(() => sweep(), 60_000); // sweep every minute
}

export function stopPromptCache() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  // Persist all remaining entries
  for (const entry of entries.values()) {
    persistEntry(entry);
  }
  entries.clear();
}

// ── Test helpers ──

export function _reset() {
  entries.clear();
  cacheStats.clear();
}

export function _getEntries() {
  return entries;
}

export function _setLogDir(dir: string) {
  logDir = dir;
}