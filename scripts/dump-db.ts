import "../src/db.js";
import { db } from "../src/db.js";

console.log("=== Providers ===");
const providers = db.prepare("SELECT * FROM providers").all();
console.table(providers.map((r: any) => ({ ...r, models: JSON.parse(r.models).length + " models" })));

console.log("\n=== Upstream Keys ===");
const keys = db.prepare("SELECT * FROM upstream_keys").all();
console.table(keys.map((r: any) => ({
  id: r.id,
  provider_id: r.provider_id,
  alias: r.alias,
  api_key: r.api_key.slice(0, 4) + "****" + r.api_key.slice(-4),
  rpm_limit: r.rpm_limit,
  tpm_limit: r.tpm_limit,
  enabled: r.enabled,
})));

console.log("\n=== Gate Keys ===");
const gateKeys = db.prepare("SELECT * FROM gate_keys").all();
console.table(gateKeys.map((r: any) => ({
  id: r.id,
  name: r.name,
  format: r.format,
  upstream_key_ids: r.upstream_key_ids,
  enabled: r.enabled,
})));

console.log(`\nTotal: ${providers.length} providers, ${keys.length} upstream keys, ${gateKeys.length} gate keys`);
