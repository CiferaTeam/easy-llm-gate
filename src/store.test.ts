import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

// Stand up an in-memory DB with the same schema as db.ts
function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE providers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'openai',
      base_url   TEXT NOT NULL,
      models     TEXT NOT NULL DEFAULT '[]',
      builtin    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE upstream_keys (
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
    CREATE TABLE gate_keys (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      upstream_key_ids TEXT NOT NULL DEFAULT '[]',
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

/**
 * Mirrors the deleteUpstreamKey logic from store.ts (lines 285-297)
 */
function deleteUpstreamKey(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM upstream_keys WHERE id = ?").run(id);
  if (!result.changes) return false;

  const rows = db.prepare("SELECT * FROM gate_keys").all() as any[];
  for (const row of rows) {
    const ids: string[] = JSON.parse(row.upstream_key_ids || "[]");
    if (ids.includes(id)) {
      const updated = ids.filter((kid) => kid !== id);
      db.prepare("UPDATE gate_keys SET upstream_key_ids = ? WHERE id = ?").run(
        JSON.stringify(updated),
        row.id
      );
    }
  }
  return true;
}

// ── Tests ──

describe("deleteUpstreamKey → cascade to gate_keys", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Seed a provider
    db.prepare(
      "INSERT INTO providers (id, name, base_url) VALUES ('p1', 'TestProvider', 'https://example.com')"
    ).run();
    // Seed two upstream keys
    db.prepare(
      "INSERT INTO upstream_keys (id, provider_id, api_key) VALUES ('uk1', 'p1', 'key-aaa')"
    ).run();
    db.prepare(
      "INSERT INTO upstream_keys (id, provider_id, api_key) VALUES ('uk2', 'p1', 'key-bbb')"
    ).run();
  });

  it("should remove deleted upstream key id from associated gate_keys", () => {
    // gate key references both upstream keys
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk1', 'MyGate', '["uk1","uk2"]')`
    ).run();

    deleteUpstreamKey(db, "uk1");

    const gk = db.prepare("SELECT * FROM gate_keys WHERE id = 'gk1'").get() as any;
    const remaining: string[] = JSON.parse(gk.upstream_key_ids);
    expect(remaining).toEqual(["uk2"]);
  });

  it("should leave unrelated gate_keys untouched", () => {
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk1', 'Related', '["uk1","uk2"]')`
    ).run();
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk2', 'Unrelated', '["uk2"]')`
    ).run();

    deleteUpstreamKey(db, "uk1");

    const gk2 = db.prepare("SELECT * FROM gate_keys WHERE id = 'gk2'").get() as any;
    expect(JSON.parse(gk2.upstream_key_ids)).toEqual(["uk2"]);
  });

  it("should result in empty array when the only upstream key is deleted", () => {
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk1', 'Solo', '["uk1"]')`
    ).run();

    deleteUpstreamKey(db, "uk1");

    const gk = db.prepare("SELECT * FROM gate_keys WHERE id = 'gk1'").get() as any;
    expect(JSON.parse(gk.upstream_key_ids)).toEqual([]);
  });

  it("should clean up multiple gate_keys that reference the same upstream key", () => {
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk1', 'Gate1', '["uk1","uk2"]')`
    ).run();
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk2', 'Gate2', '["uk1"]')`
    ).run();

    deleteUpstreamKey(db, "uk1");

    const gk1 = db.prepare("SELECT * FROM gate_keys WHERE id = 'gk1'").get() as any;
    const gk2 = db.prepare("SELECT * FROM gate_keys WHERE id = 'gk2'").get() as any;
    expect(JSON.parse(gk1.upstream_key_ids)).toEqual(["uk2"]);
    expect(JSON.parse(gk2.upstream_key_ids)).toEqual([]);
  });

  it("should return false and do nothing when upstream key does not exist", () => {
    db.prepare(
      `INSERT INTO gate_keys (id, name, upstream_key_ids) VALUES ('gk1', 'Gate', '["uk1"]')`
    ).run();

    const result = deleteUpstreamKey(db, "nonexistent");

    expect(result).toBe(false);
    const gk = db.prepare("SELECT * FROM gate_keys WHERE id = 'gk1'").get() as any;
    expect(JSON.parse(gk.upstream_key_ids)).toEqual(["uk1"]);
  });
});
