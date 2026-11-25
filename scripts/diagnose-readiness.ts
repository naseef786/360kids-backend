import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { database } from "../src/database.js";

// Read-only preflight. Never print connection strings, credentials, or query errors.
const authConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
console.log(`Authentication configuration: ${authConfigured ? "present" : "missing"}`);

if (!process.env.DATABASE_URL) {
  console.log("Database configuration: missing");
  process.exitCode = 1;
} else {
  let db: ReturnType<typeof database> | undefined;
  let phase = "connection";
  try {
    db = database();
    const connection = await db.connect();
    try {
      phase = "migration ledger";
      const rows = (await connection.query("SELECT name,checksum FROM app.schema_migrations")).rows;
      phase = "migration files";
      const applied = new Map(rows.map((row) => [String(row.name), String(row.checksum)]));
      const directory = new URL("../database/migrations/", import.meta.url);
      const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
      const problems: string[] = [];
      for (const name of names) {
        const checksum = createHash("sha256").update(await readFile(new URL(name, directory), "utf8")).digest("hex");
        if (!applied.has(name)) problems.push(`${name}: not applied`);
        else if (applied.get(name) !== checksum) problems.push(`${name}: checksum mismatch`);
      }
      console.log(`Database connection: available`);
      console.log(`Required migrations: ${names.length - problems.length}/${names.length} matched`);
      for (const problem of problems) console.log(problem);
      if (problems.length || !authConfigured) process.exitCode = 1;
    } finally {
      connection.release();
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{2,20}$/.test(error.code) ? ` (${error.code})` : "";
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const category = /tenant or user not found/.test(message) ? "pooler tenant or user not found" :
      /password authentication failed|invalid password/.test(message) ? "database password rejected" :
      /certificate|self.signed|ssl|tls/.test(message) ? "TLS verification failed" :
      /timeout|timed out/.test(message) ? "connection timed out" : "unclassified";
    console.log(`${phase === "connection" ? "Database connection" : phase === "migration ledger" ? "Database migration ledger" : "Local migration files"}: unavailable${code}`);
    if (phase === "connection") console.log(`Connection failure category: ${category}`);
    if (phase === "connection" && category === "unclassified") {
      const indicators = ["tenant", "user", "password", "authentication", "project", "paused", "pooler", "database", "connection", "internal", "invalid", "server", "limit"]
        .filter((word) => message.includes(word));
      console.log(`Safe error indicators: ${indicators.length ? indicators.join(", ") : "none"}`);
    }
    process.exitCode = 1;
  } finally {
    await db?.end?.();
  }
}
