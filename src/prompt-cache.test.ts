import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hashPrefix,
  recordPrompt,
  recordCacheUsage,
  sweep,
  getLiveEntries,
  getCacheStats,
  getPrefixReuseRate,
  _reset,
  _getEntries,
  _setLogDir,
} from "./prompt-cache.js";

function makeMessages(systemText: string, userText: string) {
  return [
    { role: "system", content: systemText },
    { role: "user", content: userText },
  ];
}

const LONG_SYSTEM = "A".repeat(2000); // well over 1024 chars

describe("prompt-cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    _reset();
    tmpDir = mkdtempSync(join(tmpdir(), "prompt-cache-test-"));
    _setLogDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── hashPrefix ──

  describe("hashPrefix", () => {
    it("should produce same hash for messages with same first 1024 chars", () => {
      const msgs1 = makeMessages(LONG_SYSTEM, "question A");
      const msgs2 = makeMessages(LONG_SYSTEM, "question B");
      // Both share the same long system prompt, so first 1024 chars of
      // JSON.stringify should be identical
      expect(hashPrefix(msgs1)).toBe(hashPrefix(msgs2));
    });

    it("should produce different hash for different prefixes", () => {
      const msgs1 = makeMessages("System prompt A", "hello");
      const msgs2 = makeMessages("System prompt B", "hello");
      expect(hashPrefix(msgs1)).not.toBe(hashPrefix(msgs2));
    });

    it("should return a 16-char hex string", () => {
      const hash = hashPrefix(makeMessages("test", "hello"));
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // ── recordPrompt ──

  describe("recordPrompt", () => {
    it("should create a new entry on first call", () => {
      recordPrompt({
        messages: makeMessages(LONG_SYSTEM, "first question"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "my-gate",
        tokens: 100,
      });

      const live = getLiveEntries();
      expect(live).toHaveLength(1);
      expect(live[0].hitCount).toBe(1);
      expect(live[0].totalTokens).toBe(100);
      expect(live[0].model).toBe("gpt-4o");
      expect(live[0].suffixPreview).toBe("first question");
    });

    it("should increment hitCount on same prefix", () => {
      const opts = {
        messages: makeMessages(LONG_SYSTEM, "q1"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "my-gate",
        tokens: 50,
      };
      recordPrompt(opts);
      recordPrompt({ ...opts, messages: makeMessages(LONG_SYSTEM, "q2"), tokens: 80 });

      const live = getLiveEntries();
      expect(live).toHaveLength(1);
      expect(live[0].hitCount).toBe(2);
      expect(live[0].totalTokens).toBe(130);
      // suffixPreview should be updated to latest
      expect(live[0].suffixPreview).toBe("q2");
    });

    it("should update messages to latest on same prefix", () => {
      recordPrompt({
        messages: makeMessages(LONG_SYSTEM, "old question"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 10,
      });
      const newMsgs = makeMessages(LONG_SYSTEM, "new question");
      recordPrompt({
        messages: newMsgs,
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 20,
      });

      const entry = getLiveEntries()[0];
      // Messages should be the latest (longer conversation)
      expect(entry.messages).toEqual(newMsgs);
    });

    it("should create separate entries for different prefixes", () => {
      recordPrompt({
        messages: makeMessages("System A", "hello"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 10,
      });
      recordPrompt({
        messages: makeMessages("System B", "hello"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 20,
      });

      expect(getLiveEntries()).toHaveLength(2);
    });
  });

  // ── TTL & sweep ──

  describe("sweep", () => {
    it("should not remove entries within TTL", () => {
      recordPrompt({
        messages: makeMessages(LONG_SYSTEM, "q"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 10,
      });

      // Sweep at current time — entry just created, should survive
      sweep(Date.now());
      expect(getLiveEntries()).toHaveLength(1);
    });

    it("should remove and persist entries past TTL", () => {
      recordPrompt({
        messages: makeMessages(LONG_SYSTEM, "q"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "my-gate",
        tokens: 10,
      });

      // Sweep 11 minutes in the future
      sweep(Date.now() + 11 * 60 * 1000);

      expect(getLiveEntries()).toHaveLength(0);

      // Check file was written
      const files = readdirSync(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f]+_my-gate\.json$/);

      const content = JSON.parse(readFileSync(join(tmpDir, files[0]), "utf-8"));
      expect(content.hitCount).toBe(1);
      expect(content.messages).toHaveLength(2);
    });

    it("should keep entries that were recently updated", () => {
      recordPrompt({
        messages: makeMessages(LONG_SYSTEM, "q1"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 10,
      });

      // Manually set updatedAt to 5 minutes ago
      const entry = _getEntries().values().next().value!;
      entry.updatedAt = Date.now() - 5 * 60 * 1000;

      // Sweep now — 5 min < 10 min TTL, should survive
      sweep(Date.now());
      expect(getLiveEntries()).toHaveLength(1);
    });

    it("should sanitize gate key name in filename", () => {
      recordPrompt({
        messages: makeMessages("sys", "q"),
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "my gate/key!@#",
        tokens: 10,
      });

      sweep(Date.now() + 11 * 60 * 1000);

      const files = readdirSync(tmpDir);
      expect(files).toHaveLength(1);
      // Special chars replaced with _
      expect(files[0]).toContain("my_gate_key___");
    });
  });

  // ── Cache stats ──

  describe("recordCacheUsage / getCacheStats", () => {
    it("should accumulate cache stats per upstream key", () => {
      recordCacheUsage("uk1", 5000, 0);
      recordCacheUsage("uk1", 0, 4800);
      recordCacheUsage("uk2", 3000, 0);

      const stats = getCacheStats();
      expect(stats.get("uk1")).toEqual({
        cacheCreationTokens: 5000,
        cacheReadTokens: 4800,
        totalRequests: 2,
      });
      expect(stats.get("uk2")).toEqual({
        cacheCreationTokens: 3000,
        cacheReadTokens: 0,
        totalRequests: 1,
      });
    });
  });

  // ── Reuse rate ──

  describe("getPrefixReuseRate", () => {
    it("should return 0 when no entries", () => {
      const { reuseRate } = getPrefixReuseRate();
      expect(reuseRate).toBe(0);
    });

    it("should calculate reuse rate correctly", () => {
      // 2 unique prefixes, 5 total hits → reuse = 1 - 2/5 = 0.6
      const LONG_SYSTEM_B = "B".repeat(2000);
      const opts = {
        model: "gpt-4o",
        upstreamKeyId: "uk1",
        gateKeyId: "gk1",
        gateKeyName: "gate",
        tokens: 10,
      };
      recordPrompt({ ...opts, messages: makeMessages(LONG_SYSTEM, "q1") });
      recordPrompt({ ...opts, messages: makeMessages(LONG_SYSTEM, "q2") });
      recordPrompt({ ...opts, messages: makeMessages(LONG_SYSTEM, "q3") });
      recordPrompt({ ...opts, messages: makeMessages(LONG_SYSTEM_B, "q1") });
      recordPrompt({ ...opts, messages: makeMessages(LONG_SYSTEM_B, "q2") });

      const { totalEntries, totalHits, reuseRate } = getPrefixReuseRate();
      expect(totalEntries).toBe(2);
      expect(totalHits).toBe(5);
      expect(reuseRate).toBeCloseTo(0.6);
    });
  });
});
