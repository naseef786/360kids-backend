import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Connection } from "./database.js";
export class MigrationError extends Error {}

export const REQUIRED_MIGRATIONS = [
  "001_platform.sql",
  "002_base_features.sql",
  "003_notifications.sql",
  "004_private_access_indexes.sql",
] as const;

export async function readMigrations() {
  const folder = new URL("../database/migrations/", import.meta.url);
  return Promise.all(
    (await readdir(folder))
      .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
      .sort()
      .map(async (name) => {
        const sql = await readFile(new URL(name, folder), "utf8");
        return {
          name,
          sql,
          checksum: createHash("sha256").update(sql).digest("hex"),
        };
      }),
  );
}

export async function applyMigrations(client: Connection) {
  const migrations = await readMigrations(),
    applied: string[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(3602026)");
    await client.query("CREATE SCHEMA IF NOT EXISTS app");
    await client.query("REVOKE ALL ON SCHEMA app FROM PUBLIC");
    const existing = (
      await client.query(
        "SELECT to_regclass('app.migrations') IS NOT NULL AS ledger, EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='app') AS tables",
      )
    ).rows[0];
    if (!existing.ledger && existing.tables)
      throw new MigrationError(
        "Unmanaged application schema: review and baseline existing tables before migrating.",
      );
    await client.query(
      "CREATE TABLE IF NOT EXISTS app.migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const migration of migrations) {
      const row = (
        await client.query(
          "SELECT checksum FROM app.migrations WHERE name=$1",
          [migration.name],
        )
      ).rows[0];
      if (row) {
        if (row.checksum !== migration.checksum)
          throw new MigrationError(
            "Applied migration changed: " + migration.name,
          );
      } else {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO app.migrations(name,checksum) VALUES($1,$2)",
          [migration.name, migration.checksum],
        );
        applied.push(migration.name);
      }
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
