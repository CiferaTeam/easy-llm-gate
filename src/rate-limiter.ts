/**
 * Rate limiter with token bucket (RPM) + sliding window (TPM) + queue.
 *
 * RPM: classic token bucket. Capacity = rpm_limit, refills at rpm_limit/60 per second.
 * TPM: sliding 60-second window. If total tokens in window >= tpm_limit, block new requests.
 * Queue: when no tokens available, requests wait in FIFO queue. Scheduler polls every 100ms.
 */

import { getUpstreamKey } from "./store.js";

// ── Types ──

export type RequestStatus = "queued" | "executing" | "streaming";

export interface TrackedRequest {
  id: string;
  upstreamKeyId: string;
  gateKeyId: string;
  gateKeyName: string;
  model: string;
  status: RequestStatus;
  enqueuedAt: number;
  startedAt?: number;
}

interface QueueItem {
  resolve: () => void;
  request: TrackedRequest;
}

interface BucketState {
  tokens: number;
  capacity: number;
  refillRate: number; // tokens per ms
  lastRefill: number;
  tpmLimit: number;
  tpmWindow: { ts: number; tokens: number }[];
  queue: QueueItem[];
}

// ── State ──

const buckets = new Map<string, BucketState>();
const activeRequests = new Map<string, TrackedRequest>();
let requestCounter = 0;

// ── Helpers ──

function getOrCreateBucket(
  upstreamKeyId: string,
  rpmLimit: number,
  tpmLimit: number
): BucketState {
  let b = buckets.get(upstreamKeyId);
  if (!b) {
    b = {
      tokens: rpmLimit,
      capacity: rpmLimit,
      refillRate: rpmLimit / 60 / 1000,
      lastRefill: Date.now(),
      tpmLimit,
      tpmWindow: [],
      queue: [],
    };
    buckets.set(upstreamKeyId, b);
  }
  // Sync limits if they changed in DB
  b.capacity = rpmLimit;
  b.refillRate = rpmLimit / 60 / 1000;
  b.tpmLimit = tpmLimit;
  return b;
}

function refillBucket(b: BucketState) {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillRate);
  b.lastRefill = now;
}

function getCurrentTPM(b: BucketState): number {
  const cutoff = Date.now() - 60_000;
  b.tpmWindow = b.tpmWindow.filter((e) => e.ts > cutoff);
  return b.tpmWindow.reduce((sum, e) => sum + e.tokens, 0);
}

function canAcquire(b: BucketState): boolean {
  refillBucket(b);
  if (b.tokens < 1) return false;
  if (b.tpmLimit > 0 && getCurrentTPM(b) >= b.tpmLimit) return false;
  return true;
}

/** Check if an upstream key can accept a request right now (without consuming). */
export function canAcquireForKey(upstreamKeyId: string, rpmLimit: number, tpmLimit: number): boolean {
  const b = getOrCreateBucket(upstreamKeyId, rpmLimit, tpmLimit);
  return canAcquire(b);
}

// ── Public API ──

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${(++requestCounter).toString(36)}`;
}

/**
 * Acquire a rate-limit slot for this upstream key.
 * If tokens are available, returns immediately.
 * Otherwise, the promise is held until the scheduler releases a token.
 */
export async function acquire(
  upstreamKeyId: string,
  requestId: string,
  gateKeyId: string,
  gateKeyName: string,
  model: string
): Promise<void> {
  const uk = await getUpstreamKey(upstreamKeyId);
  const rpmLimit = uk?.rpm_limit ?? 60;
  const tpmLimit = uk?.tpm_limit ?? 100000;
  const b = getOrCreateBucket(upstreamKeyId, rpmLimit, tpmLimit);

  const tracked: TrackedRequest = {
    id: requestId,
    upstreamKeyId,
    gateKeyId,
    gateKeyName,
    model,
    status: "queued",
    enqueuedAt: Date.now(),
  };
  activeRequests.set(requestId, tracked);

  if (canAcquire(b)) {
    b.tokens -= 1;
    tracked.status = "executing";
    tracked.startedAt = Date.now();
    return;
  }

  // Queue and hold the HTTP connection
  return new Promise<void>((resolve) => {
    b.queue.push({ resolve, request: tracked });
  });
}

export function updateStatus(requestId: string, status: RequestStatus) {
  const r = activeRequests.get(requestId);
  if (r) {
    r.status = status;
    if (status === "executing" && !r.startedAt) {
      r.startedAt = Date.now();
    }
  }
}

/** Call when request is fully done. Records token usage for TPM window. */
export function releaseRequest(requestId: string, tokens: number) {
  const r = activeRequests.get(requestId);
  if (r) {
    const b = buckets.get(r.upstreamKeyId);
    if (b && tokens > 0) {
      b.tpmWindow.push({ ts: Date.now(), tokens });
    }
    activeRequests.delete(requestId);
  }
}

// ── Scheduler ──

function processQueues() {
  for (const [, b] of buckets) {
    while (b.queue.length > 0) {
      if (!canAcquire(b)) break;
      b.tokens -= 1;
      const item = b.queue.shift()!;
      item.request.status = "executing";
      item.request.startedAt = Date.now();
      item.resolve();
    }
  }
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startRateLimiter() {
  schedulerTimer = setInterval(processQueues, 100);
  console.log("[rate-limiter] started (100ms scheduler)");
}

export function stopRateLimiter() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

// ── Query request status by ID ──

/** Returns the status of a tracked request, or null if not in-flight. */
export function getRequestStatus(requestId: string): RequestStatus | null {
  const r = activeRequests.get(requestId);
  return r ? r.status : null;
}

/** Get bucket stats for a given upstream key. */
export function getBucketStats(upstreamKeyId: string): {
  rpm: { limit: number; available: number; queued: number };
  tpm: { limit: number; used: number };
} | null {
  const b = buckets.get(upstreamKeyId);
  if (!b) return null;
  refillBucket(b);
  return {
    rpm: {
      limit: b.capacity,
      available: Math.floor(b.tokens),
      queued: b.queue.length,
    },
    tpm: {
      limit: b.tpmLimit,
      used: getCurrentTPM(b),
    },
  };
}
