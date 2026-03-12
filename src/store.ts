import { db } from "./db.js";
import { builtinProviders, getBuiltinProvider, type BuiltinProvider } from "./builtin-providers.js";
import { canAcquireForKey } from "./rate-limiter.js";

// ── Interfaces ──

export interface Provider {
  id: string;
  name: string;
  type: "openai" | "anthropic" | "custom";
  base_url: string;
  models: string[];
  builtin: boolean;
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

// Row → typed object helpers

function rowToProvider(row: any): Provider {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Provider["type"],
    base_url: row.base_url,
    models: JSON.parse(row.models || "[]"),
    builtin: row.builtin === 1,
    created_at: row.created_at,
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

function rowToUpstreamKey(row: any): UpstreamKey {
  return {
    id: row.id,
    provider_id: row.provider_id,
    api_key: row.api_key,
    alias: row.alias || "",
    rpm_limit: row.rpm_limit,
    tpm_limit: row.tpm_limit,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

function rowToGateKey(row: any): GateKey {
  return {
    id: row.id,
    name: row.name,
    upstream_key_ids: JSON.parse(row.upstream_key_ids || "[]"),
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

// ── Prepared statements ──

const stmts = {
  // Providers
  allProviders: db.prepare("SELECT * FROM providers"),
  getProvider: db.prepare("SELECT * FROM providers WHERE id = ?"),
  insertProvider: db.prepare(
    "INSERT INTO providers (id, name, type, base_url, models, builtin, created_at) VALUES (@id, @name, @type, @base_url, @models, @builtin, @created_at)"
  ),
  updateProvider: db.prepare(
    "UPDATE providers SET name = @name, type = @type, base_url = @base_url, models = @models WHERE id = @id"
  ),
  deleteProvider: db.prepare("DELETE FROM providers WHERE id = ?"),

  // Upstream keys
  allUpstreamKeys: db.prepare("SELECT * FROM upstream_keys"),
  getUpstreamKey: db.prepare("SELECT * FROM upstream_keys WHERE id = ?"),
  getUpstreamKeysByProvider: db.prepare("SELECT * FROM upstream_keys WHERE provider_id = ?"),
  insertUpstreamKey: db.prepare(
    "INSERT INTO upstream_keys (id, provider_id, api_key, alias, rpm_limit, tpm_limit, enabled, created_at) VALUES (@id, @provider_id, @api_key, @alias, @rpm_limit, @tpm_limit, @enabled, @created_at)"
  ),
  deleteUpstreamKey: db.prepare("DELETE FROM upstream_keys WHERE id = ?"),

  // Gate keys
  allGateKeys: db.prepare("SELECT * FROM gate_keys"),
  getGateKey: db.prepare("SELECT * FROM gate_keys WHERE id = ?"),
  insertGateKey: db.prepare(
    "INSERT INTO gate_keys (id, name, upstream_key_ids, enabled, created_at) VALUES (@id, @name, @upstream_key_ids, @enabled, @created_at)"
  ),
  deleteGateKey: db.prepare("DELETE FROM gate_keys WHERE id = ?"),
  updateGateKeyUpstreamIds: db.prepare(
    "UPDATE gate_keys SET upstream_key_ids = ? WHERE id = ?"
  ),
};

// ── Provider CRUD ──

export async function getProviders(): Promise<Provider[]> {
  const rows = stmts.allProviders.all();
  const dbProviders = rows.map(rowToProvider);
  const dbIds = new Set(dbProviders.map((p) => p.id));

  const merged: Provider[] = [];
  for (const bp of builtinProviders) {
    if (dbIds.has(bp.id)) {
      merged.push(dbProviders.find((p) => p.id === bp.id)!);
    } else {
      merged.push(builtinToProvider(bp));
    }
  }
  for (const dp of dbProviders) {
    if (!builtinProviders.some((bp) => bp.id === dp.id)) {
      merged.push(dp);
    }
  }
  return merged;
}

export async function getProvider(id: string): Promise<Provider | undefined> {
  const row = stmts.getProvider.get(id);
  if (row) return rowToProvider(row);
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
  stmts.insertProvider.run({
    id: p.id,
    name: p.name,
    type: p.type,
    base_url: p.base_url,
    models: JSON.stringify(p.models),
    builtin: 0,
    created_at: p.created_at,
  });
  return p;
}

export async function updateProvider(
  id: string,
  data: Partial<Pick<Provider, "name" | "type" | "base_url" | "models">>
): Promise<Provider | undefined> {
  let existing = await getProvider(id);
  if (!existing) return undefined;

  const row = stmts.getProvider.get(id);
  if (!row) {
    // Builtin not yet in DB — copy it
    const full: Provider = { ...existing, ...data, builtin: true };
    stmts.insertProvider.run({
      id: full.id,
      name: full.name,
      type: full.type,
      base_url: full.base_url,
      models: JSON.stringify(full.models),
      builtin: 1,
      created_at: full.created_at,
    });
    return full;
  }

  const updated = {
    id,
    name: data.name ?? existing.name,
    type: data.type ?? existing.type,
    base_url: data.base_url ? data.base_url.replace(/\/+$/, "") : existing.base_url,
    models: JSON.stringify(data.models ?? existing.models),
  };
  stmts.updateProvider.run(updated);
  return getProvider(id);
}

export async function deleteProvider(id: string): Promise<boolean> {
  // CASCADE will handle upstream_keys deletion via FK
  const result = stmts.deleteProvider.run(id);
  if (!result.changes) return false;
  // Also clean up gate_keys referencing deleted upstream keys
  const gateKeys = stmts.allGateKeys.all().map(rowToGateKey);
  const remainingUkIds = new Set(
    (stmts.allUpstreamKeys.all() as any[]).map((r) => r.id)
  );
  for (const gk of gateKeys) {
    const filtered = gk.upstream_key_ids.filter((ukId) => remainingUkIds.has(ukId));
    if (filtered.length !== gk.upstream_key_ids.length) {
      stmts.updateGateKeyUpstreamIds.run(JSON.stringify(filtered), gk.id);
    }
  }
  return true;
}

// ── Upstream Key CRUD ──

export async function getUpstreamKeys(): Promise<UpstreamKey[]> {
  return stmts.allUpstreamKeys.all().map(rowToUpstreamKey);
}

export async function getUpstreamKey(id: string): Promise<UpstreamKey | undefined> {
  const row = stmts.getUpstreamKey.get(id);
  return row ? rowToUpstreamKey(row) : undefined;
}

export async function getUpstreamKeysByProvider(providerId: string): Promise<UpstreamKey[]> {
  return stmts.getUpstreamKeysByProvider.all(providerId).map(rowToUpstreamKey);
}

export async function addUpstreamKey(data: {
  provider_id: string;
  api_key: string;
  alias?: string;
  rpm_limit?: number;
  tpm_limit?: number;
}): Promise<UpstreamKey> {
  // Ensure builtin provider is persisted to DB before FK insert
  const dbRow = stmts.getProvider.get(data.provider_id);
  if (!dbRow) {
    const bp = getBuiltinProvider(data.provider_id);
    if (bp) {
      stmts.insertProvider.run({
        id: bp.id,
        name: bp.name,
        type: bp.type,
        base_url: bp.base_url,
        models: JSON.stringify(bp.models),
        builtin: 1,
        created_at: Date.now(),
      });
    }
  }
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
  stmts.insertUpstreamKey.run({
    id: k.id,
    provider_id: k.provider_id,
    api_key: k.api_key,
    alias: k.alias,
    rpm_limit: k.rpm_limit,
    tpm_limit: k.tpm_limit,
    enabled: 1,
    created_at: k.created_at,
  });
  return k;
}

export async function deleteUpstreamKey(id: string): Promise<boolean> {
  const result = stmts.deleteUpstreamKey.run(id);
  if (!result.changes) return false;
  // Remove from all gate keys
  const gateKeys = stmts.allGateKeys.all().map(rowToGateKey);
  for (const gk of gateKeys) {
    if (gk.upstream_key_ids.includes(id)) {
      const updated = gk.upstream_key_ids.filter((kid) => kid !== id);
      stmts.updateGateKeyUpstreamIds.run(JSON.stringify(updated), gk.id);
    }
  }
  return true;
}

// ── Gate Key CRUD ──

export async function getGateKeys(): Promise<GateKey[]> {
  return stmts.allGateKeys.all().map(rowToGateKey);
}

export async function getGateKey(id: string): Promise<GateKey | undefined> {
  const row = stmts.getGateKey.get(id);
  return row ? rowToGateKey(row) : undefined;
}

export async function addGateKey(data: {
  name: string;
  upstream_key_ids?: string[];
}): Promise<GateKey> {
  const gk: GateKey = {
    id: `gk_${Date.now().toString(36)}_${(++idCounter).toString(36)}`,
    name: data.name,
    upstream_key_ids: data.upstream_key_ids ?? [],
    enabled: true,
    created_at: Date.now(),
  };
  stmts.insertGateKey.run({
    id: gk.id,
    name: gk.name,
    upstream_key_ids: JSON.stringify(gk.upstream_key_ids),
    enabled: 1,
    created_at: gk.created_at,
  });
  return gk;
}

export async function deleteGateKey(id: string): Promise<boolean> {
  const result = stmts.deleteGateKey.run(id);
  return result.changes > 0;
}

export async function updateGateKeyUpstreamKeys(
  id: string,
  upstream_key_ids: string[]
): Promise<GateKey | null> {
  const row = stmts.getGateKey.get(id);
  if (!row) return null;
  stmts.updateGateKeyUpstreamIds.run(JSON.stringify(upstream_key_ids), id);
  const updated = stmts.getGateKey.get(id);
  return updated ? rowToGateKey(updated) : null;
}

// ── Proxy Helpers ──

export async function authenticateGateKey(apiKey: string): Promise<GateKey | null> {
  const row = stmts.getGateKey.get(apiKey);
  if (!row) return null;
  const gk = rowToGateKey(row);
  return gk.enabled ? gk : null;
}

export async function findUpstreamForGateKey(
  gateKey: GateKey,
  providerType?: Provider["type"]
): Promise<{ key: UpstreamKey; provider: Provider } | null> {
  // First eligible match (for fallback if all are throttled)
  let firstEligible: { key: UpstreamKey; provider: Provider } | null = null;

  for (const ukId of gateKey.upstream_key_ids) {
    const ukRow = stmts.getUpstreamKey.get(ukId);
    if (!ukRow) continue;
    const uk = rowToUpstreamKey(ukRow);
    if (!uk.enabled) continue;
    const provider = await getProvider(uk.provider_id);
    if (!provider) continue;
    if (providerType && provider.type !== providerType) continue;

    if (!firstEligible) firstEligible = { key: uk, provider };

    // Check if this key has rate limit capacity
    if (canAcquireForKey(uk.id, uk.rpm_limit ?? 60, uk.tpm_limit ?? 100000)) {
      return { key: uk, provider };
    }
  }

  // All keys throttled — fall back to first eligible (will queue there)
  return firstEligible;
}

// Legacy: find any available key (no gate key auth)
export async function findKeyForProxy(providerType?: Provider["type"]): Promise<{
  key: UpstreamKey;
  provider: Provider;
} | null> {
  const allKeys = stmts.allUpstreamKeys.all().map(rowToUpstreamKey);
  for (const uk of allKeys) {
    if (!uk.enabled) continue;
    const provider = await getProvider(uk.provider_id);
    if (!provider) continue;
    if (providerType && provider.type !== providerType) continue;
    return { key: uk, provider };
  }
  return null;
}
