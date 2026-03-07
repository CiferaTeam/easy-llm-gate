// In-memory storage for MVP (will migrate to Redis later)

export interface Provider {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "custom";
  base_url: string;
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

const providers = new Map<string, Provider>();
const upstreamKeys = new Map<string, UpstreamKey>();

let idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****" + key.slice(-2);
  return key.slice(0, 4) + "****" + key.slice(-4);
}

// ── Provider CRUD ──

export function getProviders(): Provider[] {
  return Array.from(providers.values());
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

export function addProvider(data: {
  name: string;
  type?: Provider["type"];
  base_url: string;
}): Provider {
  const p: Provider = {
    id: generateId("prov"),
    name: data.name,
    type: data.type ?? "openai",
    base_url: data.base_url.replace(/\/+$/, ""), // trim trailing slash
    created_at: Date.now(),
  };
  providers.set(p.id, p);
  return p;
}

export function deleteProvider(id: string): boolean {
  if (!providers.delete(id)) return false;
  // cascade delete upstream keys
  for (const [kid, k] of upstreamKeys) {
    if (k.provider_id === id) upstreamKeys.delete(kid);
  }
  return true;
}

// ── Upstream Key CRUD ──

export function getUpstreamKeys(): UpstreamKey[] {
  return Array.from(upstreamKeys.values());
}

export function getUpstreamKey(id: string): UpstreamKey | undefined {
  return upstreamKeys.get(id);
}

export function getUpstreamKeysByProvider(providerId: string): UpstreamKey[] {
  return Array.from(upstreamKeys.values()).filter(
    (k) => k.provider_id === providerId
  );
}

export function addUpstreamKey(data: {
  provider_id: string;
  api_key: string;
  alias?: string;
  rpm_limit?: number;
  tpm_limit?: number;
}): UpstreamKey {
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
  upstreamKeys.set(k.id, k);
  return k;
}

export function deleteUpstreamKey(id: string): boolean {
  return upstreamKeys.delete(id);
}

// ── Helpers ──

export function findKeyForProxy(providerType?: Provider["type"]): {
  key: UpstreamKey;
  provider: Provider;
} | null {
  for (const k of upstreamKeys.values()) {
    if (!k.enabled) continue;
    const p = providers.get(k.provider_id);
    if (!p) continue;
    if (providerType && p.type !== providerType) continue;
    return { key: k, provider: p };
  }
  return null;
}
