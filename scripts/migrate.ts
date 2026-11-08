import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to the intended development database.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(3602026)");
  await client.query("CREATE SCHEMA IF NOT EXISTS app");
  await client.query("REVOKE ALL ON SCHEMA app FROM PUBLIC");
  await client.query(
    "CREATE TABLE IF NOT EXISTS app.migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const folder = new URL("../database/migrations/", import.meta.url);
  for (const name of (await readdir(folder))
    .filter((n) => /^\d+_[a-z_]+\.sql$/.test(n))
    .sort()) {
    const sql = await readFile(new URL(name, folder), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const row = (
      await client.query("SELECT checksum FROM app.migrations WHERE name=$1", [
        name,
      ])
    ).rows[0];
    if (row) {
      if (row.checksum !== checksum)
        throw new Error("Applied migration changed: " + name);
      continue;
    }
    await client.query(sql);
    await client.query(
      "INSERT INTO app.migrations(name,checksum) VALUES($1,$2)",
      [name, checksum],
    );
    console.log("Applied " + name);
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
