import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { transaction, type Database } from "./database.js";

// Cache immutable release files, but check the database ledger on every probe.
let manifest: Promise<{name: string; checksum: string}[]> | undefined;
function requiredMigrations() {
  return manifest ??= (async () => {
    const directory = new URL("../database/migrations/", import.meta.url);
    const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    return Promise.all(names.map(async name => ({name, checksum: createHash("sha256").update(await readFile(new URL(name,directory),"utf8")).digest("hex")})));
  })();
}
export async function migrationsReady(db: Database) {
  const expected = await requiredMigrations();
  const c = await db.connect();
  try {
    const rows = (await c.query("SELECT name,checksum FROM app.schema_migrations WHERE name=ANY($1::text[])", [expected.map(m => m.name)])).rows;
    return expected.length > 0 && expected.every(m => rows.some(r => r.name === m.name && r.checksum === m.checksum));
  } finally { c.release(); }
}

export async function migrate(db: Database) {
  const directory = new URL("../database/migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return transaction(db, async (connection) => {
    // Serialize deploys on real PostgreSQL; each migration and its ledger entry commit together.
    await connection.query("SELECT pg_advisory_xact_lock(3604000)");
    await connection.query("CREATE SCHEMA IF NOT EXISTS app");
    await connection.query("REVOKE ALL ON SCHEMA app FROM PUBLIC");
    await connection.query(
      "CREATE TABLE IF NOT EXISTS app.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied: string[] = [];
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = (
        await connection.query(
          "SELECT checksum FROM app.schema_migrations WHERE name=$1",
          [name],
        )
      ).rows[0];
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await connection.query(sql);
      await connection.query(
        "INSERT INTO app.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
      applied.push(name);
    }
    return applied;
  });
}
