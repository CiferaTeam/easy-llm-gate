export interface Provider {
  id: string;
  name: string;
  type: string;
  base_url: string;
  models: string[];
  builtin: boolean;
  created_at: number;
}

export interface BuiltinProvider {
  id: string;
  name: string;
  type: "openai" | "anthropic";
  base_url: string;
  models: string[];
}

export interface UpstreamKey {
  id: string;
  provider_id: string;
  api_key: string; // masked
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

export async function fetchBuiltinProviders(): Promise<BuiltinProvider[]> {
  const r = await fetch("/api/builtin-providers");
  return r.json();
}

export async function fetchProviders(): Promise<Provider[]> {
  const r = await fetch("/api/providers");
  return r.json();
}

export async function createProvider(data: {
  name: string;
  type?: string;
  base_url: string;
  models?: string[];
}): Promise<Provider> {
  const r = await fetch("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateProvider(
  id: string,
  data: { name?: string; type?: string; base_url?: string; models?: string[] }
): Promise<Provider> {
  const r = await fetch(`/api/providers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteProvider(id: string): Promise<void> {
  const r = await fetch(`/api/providers/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function fetchUpstreamKeys(): Promise<UpstreamKey[]> {
  const r = await fetch("/api/upstream-keys");
  return r.json();
}

export async function createUpstreamKey(data: {
  provider_id: string;
  api_key: string;
  alias?: string;
  rpm_limit?: number;
  tpm_limit?: number;
}): Promise<UpstreamKey> {
  const r = await fetch("/api/upstream-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteUpstreamKey(id: string): Promise<void> {
  const r = await fetch(`/api/upstream-keys/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function testUpstreamKey(
  id: string
): Promise<{ ok: boolean; error?: string; models?: any }> {
  const r = await fetch(`/api/upstream-keys/${id}/test`, { method: "POST" });
  return r.json();
}

// ── Gate Keys ──

export async function fetchGateKeys(): Promise<GateKey[]> {
  const r = await fetch("/api/gate-keys");
  return r.json();
}

export async function createGateKey(data: {
  name: string;
  format?: string;
  upstream_key_ids?: string[];
}): Promise<GateKey> {
  const r = await fetch("/api/gate-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteGateKey(id: string): Promise<void> {
  const r = await fetch(`/api/gate-keys/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}
