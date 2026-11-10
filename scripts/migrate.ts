import "dotenv/config";
import pg from "pg";
import { applyMigrations, MigrationError } from "../src/migrations.js";

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to the intended development database.");
  process.exitCode = 1;
} else {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 60000,
  });
  try {
    await client.connect();
    const applied = await applyMigrations({
      query: async (sql, params) => {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      release() {},
    });
    console.log(
      applied.length
        ? "Applied: " + applied.join(", ")
        : "Database migrations are up to date.",
    );
  } catch (error) {
    // Parser/connection errors may contain credentials. Print controlled messages only.
    const message =
      error instanceof MigrationError
        ? error.message
        : "Migration failed; verify database access and settings.";
    console.error(message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
