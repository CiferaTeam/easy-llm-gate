import { redis } from "./redis.js";
import { builtinProviders, getBuiltinProvider, type BuiltinProvider } from "./builtin-providers.js";

// ── Interfaces ──

export interface Provider {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "custom";
  base_url: string;
  models: string[];
  builtin: boolean; // true = originated from builtin registry
  created_at: number;
}

export interface UpstreamKey {
  id: string;
  provider_id: string;
  api_key: string;
  alias: string;
  rpm_limit: number;
  tpm_limit: number;
  enabled: boolean;
  created_at: number;
}

export interface GateKey {
  id: string;
  name: string;
  format: "openai" | "anthropic";
  upstream_key_ids: string[];
  enabled: boolean;
  created_at: number;
}

// ── Helpers ──

let idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****" + key.slice(-2);
  return key.slice(0, 4) + "****" + key.slice(-4);
}

// Serialize/deserialize helpers for Redis Hash
function toHash(obj: Record<string, any>): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    h[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return h;
}

function parseProvider(h: Record<string, string>): Provider {
  return {
    id: h.id,
    name: h.name,
    type: h.type as Provider["type"],
    base_url: h.base_url,
    models: h.models ? JSON.parse(h.models) : [],
    builtin: h.builtin === "true",
    created_at: Number(h.created_at),
  };
}

function builtinToProvider(b: BuiltinProvider): Provider {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    base_url: b.base_url,
    models: b.models,
    builtin: true,
    created_at: 0,
  };
}

function parseUpstreamKey(h: Record<string, string>): UpstreamKey {
  return {
    id: h.id,
    provider_id: h.provider_id,
    api_key: h.api_key,
    alias: h.alias || "",
    rpm_limit: Number(h.rpm_limit),
    tpm_limit: Number(h.tpm_limit),
    enabled: h.enabled === "true",
    created_at: Number(h.created_at),
  };
}

function parseGateKey(h: Record<string, string>): GateKey {
  return {
    id: h.id,
    name: h.name,
    format: h.format as GateKey["format"],
    upstream_key_ids: JSON.parse(h.upstream_key_ids || "[]"),
    enabled: h.enabled === "true",
    created_at: Number(h.created_at),
  };
}

// ── Provider CRUD ──

export async function getProviders(): Promise<Provider[]> {
  // 1. Get all Redis providers
  const ids = await redis.smembers("providers");
  let redisProviders: Provider[] = [];
  if (ids.length) {
    const pipe = redis.pipeline();
    for (const id of ids) pipe.hgetall(`provider:${id}`);
    const results = await pipe.exec();
    redisProviders = (results || [])
      .map(([err, h]) => (err || !h || !Object.keys(h as any).length ? null : parseProvider(h as Record<string, string>)))
      .filter(Boolean) as Provider[];
  }

  // 2. Merge: builtin providers that are NOT overridden in Redis come first
  const redisIds = new Set(redisProviders.map((p) => p.id));
  const merged: Provider[] = [];
  for (const bp of builtinProviders) {
    if (redisIds.has(bp.id)) {
      // Redis override exists — use it but keep builtin flag
      merged.push(redisProviders.find((p) => p.id === bp.id)!);
    } else {
      merged.push(builtinToProvider(bp));
    }
  }
  // 3. Append user-created (non-builtin) providers
  for (const rp of redisProviders) {
    if (!builtinProviders.some((bp) => bp.id === rp.id)) {
      merged.push(rp);
    }
  }
  return merged;
}

export async function getProvider(id: string): Promise<Provider | undefined> {
  const h = await redis.hgetall(`provider:${id}`);
  if (h && h.id) return parseProvider(h);
  // Fallback to builtin
  const bp = getBuiltinProvider(id);
  return bp ? builtinToProvider(bp) : undefined;
}

export async function addProvider(data: {
  name: string;
  type?: Provider["type"];
  base_url: string;
  models?: string[];
}): Promise<Provider> {
  const p: Provider = {
    id: generateId("prov"),
    name: data.name,
    type: data.type ?? "openai",
    base_url: data.base_url.replace(/\/+$/, ""),
    models: data.models ?? [],
    builtin: false,
    created_at: Date.now(),
  };
  await redis.hset(`provider:${p.id}`, toHash(p as any));
  await redis.sadd("providers", p.id);
  return p;
}

export async function updateProvider(
  id: string,
  data: Partial<Pick<Provider, "name" | "type" | "base_url" | "models">>
): Promise<Provider | undefined> {
  // For builtin providers not yet in Redis, copy the builtin first
  let existing = await getProvider(id);
  if (!existing) return undefined;

  const isInRedis = !!(await redis.hget(`provider:${id}`, "id"));
  if (!isInRedis) {
    // Copy builtin to Redis so we can override
    const full: Provider = { ...existing, ...data, builtin: true };
    await redis.hset(`provider:${id}`, toHash(full as any));
    await redis.sadd("providers", id);
    return full;
  }

  // Update existing Redis entry
  const updates: Record<string, string> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.base_url !== undefined) updates.base_url = data.base_url.replace(/\/+$/, "");
  if (data.models !== undefined) updates.models = JSON.stringify(data.models);

  if (Object.keys(updates).length > 0) {
    await redis.hset(`provider:${id}`, updates);
  }
  return getProvider(id);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const removed = await redis.srem("providers", id);
  if (!removed) return false;
  await redis.del(`provider:${id}`);
  // cascade: delete upstream keys belonging to this provider
  const ukIds = await redis.smembers(`provider_keys:${id}`);
  for (const ukId of ukIds) {
    await deleteUpstreamKey(ukId);
  }
  await redis.del(`provider_keys:${id}`);
  return true;
}

// ── Upstream Key CRUD ──

export async function getUpstreamKeys(): Promise<UpstreamKey[]> {
  const ids = await redis.smembers("upstream_keys");
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(`upstream_key:${id}`);
  const results = await pipe.exec();
  return (results || [])
    .map(([err, h]) => (err || !h || !Object.keys(h as any).length ? null : parseUpstreamKey(h as Record<string, string>)))
    .filter(Boolean) as UpstreamKey[];
}

export async function getUpstreamKey(id: string): Promise<UpstreamKey | undefined> {
  const h = await redis.hgetall(`upstream_key:${id}`);
  if (!h || !h.id) return undefined;
  return parseUpstreamKey(h);
}

export async function getUpstreamKeysByProvider(providerId: string): Promise<UpstreamKey[]> {
  const ids = await redis.smembers(`provider_keys:${providerId}`);
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(`upstream_key:${id}`);
  const results = await pipe.exec();
  return (results || [])
    .map(([err, h]) => (err || !h || !Object.keys(h as any).length ? null : parseUpstreamKey(h as Record<string, string>)))
    .filter(Boolean) as UpstreamKey[];
}

export async function addUpstreamKey(data: {
  provider_id: string;
  api_key: string;
  alias?: string;
  rpm_limit?: number;
  tpm_limit?: number;
}): Promise<UpstreamKey> {
  const k: UpstreamKey = {
    id: generateId("uk"),
    provider_id: data.provider_id,
    api_key: data.api_key,
    alias: data.alias ?? "",
    rpm_limit: data.rpm_limit ?? 60,
    tpm_limit: data.tpm_limit ?? 100000,
    enabled: true,
    created_at: Date.now(),
  };
  await redis.hset(`upstream_key:${k.id}`, toHash(k as any));
  await redis.sadd("upstream_keys", k.id);
  await redis.sadd(`provider_keys:${k.provider_id}`, k.id);
  return k;
}

export async function deleteUpstreamKey(id: string): Promise<boolean> {
  const h = await redis.hgetall(`upstream_key:${id}`);
  if (!h || !h.id) return false;
  await redis.srem("upstream_keys", id);
  await redis.srem(`provider_keys:${h.provider_id}`, id);
  await redis.del(`upstream_key:${id}`);
  // cascade: remove from all gate keys
  const gkIds = await redis.smembers("gate_keys");
  for (const gkId of gkIds) {
    const raw = await redis.hget(`gate_key:${gkId}`, "upstream_key_ids");
    if (!raw) continue;
    const arr: string[] = JSON.parse(raw);
    if (arr.includes(id)) {
      const updated = arr.filter((kid) => kid !== id);
      await redis.hset(`gate_key:${gkId}`, "upstream_key_ids", JSON.stringify(updated));
    }
  }
  return true;
}

// ── Gate Key CRUD ──

export async function getGateKeys(): Promise<GateKey[]> {
  const ids = await redis.smembers("gate_keys");
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.hgetall(`gate_key:${id}`);
  const results = await pipe.exec();
  return (results || [])
    .map(([err, h]) => (err || !h || !Object.keys(h as any).length ? null : parseGateKey(h as Record<string, string>)))
    .filter(Boolean) as GateKey[];
}

export async function getGateKey(id: string): Promise<GateKey | undefined> {
  const h = await redis.hgetall(`gate_key:${id}`);
  if (!h || !h.id) return undefined;
  return parseGateKey(h);
}

export async function addGateKey(data: {
  name: string;
  format?: GateKey["format"];
  upstream_key_ids?: string[];
}): Promise<GateKey> {
  const gk: GateKey = {
    id: `gk_${Date.now().toString(36)}_${(++idCounter).toString(36)}`,
    name: data.name,
    format: data.format ?? "openai",
    upstream_key_ids: data.upstream_key_ids ?? [],
    enabled: true,
    created_at: Date.now(),
  };
  await redis.hset(`gate_key:${gk.id}`, toHash(gk as any));
  await redis.sadd("gate_keys", gk.id);
  return gk;
}

export async function deleteGateKey(id: string): Promise<boolean> {
  const removed = await redis.srem("gate_keys", id);
  if (!removed) return false;
  await redis.del(`gate_key:${id}`);
  return true;
}

// ── Proxy Helper ──

export async function findKeyForProxy(providerType?: Provider["type"]): Promise<{
  key: UpstreamKey;
  provider: Provider;
} | null> {
  const ukIds = await redis.smembers("upstream_keys");
  for (const ukId of ukIds) {
    const kh = await redis.hgetall(`upstream_key:${ukId}`);
    if (!kh || !kh.id || kh.enabled !== "true") continue;
    const ph = await redis.hgetall(`provider:${kh.provider_id}`);
    if (!ph || !ph.id) continue;
    if (providerType && ph.type !== providerType) continue;
    return { key: parseUpstreamKey(kh), provider: parseProvider(ph) };
  }
  return null;
}
