import "dotenv/config";
import { database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import type pg from "pg";

const pool = database() as pg.Pool;
try {
  const applied = await migrate(pool);
  console.log(
    applied.length
      ? `Applied ${applied.length} database migrations.`
      : "Database migrations are up to date.",
  );
} finally {
  await pool.end();
}
