import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "gate.db");

// Ensure data directory exists
import { mkdirSync } from "node:fs";
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// Performance pragmas
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// ── Schema ──

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'openai',
    base_url   TEXT NOT NULL,
    models     TEXT NOT NULL DEFAULT '[]',
    builtin    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS upstream_keys (
    id          TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    alias       TEXT NOT NULL DEFAULT '',
    rpm_limit   INTEGER NOT NULL DEFAULT 60,
    tpm_limit   INTEGER NOT NULL DEFAULT 100000,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS gate_keys (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    format           TEXT NOT NULL DEFAULT 'openai',
    upstream_key_ids TEXT NOT NULL DEFAULT '[]',
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_upstream_keys_provider ON upstream_keys(provider_id);
`);

console.log("[db] SQLite ready:", DB_PATH);
