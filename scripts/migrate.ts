import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to the intended development database.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    await readFile(
      new URL("../database/migrations/001_platform.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query("COMMIT");
  console.log("Platform schema applied.");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
