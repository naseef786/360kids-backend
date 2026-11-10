import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { databaseFor } from "./support/database.js";

test("versioned migrations backfill legacy owners, rerun safely and detect edits", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      await readFile(
        new URL("../database/migrations/001_platform.sql", import.meta.url),
        "utf8",
      ),
    );
    const owner = randomUUID(),
      provider = randomUUID();
    await pg.query(
      "INSERT INTO app.profiles(id,email) VALUES($1,'legacy@example.invalid')",
      [owner],
    );
    await pg.query(
      "INSERT INTO app.providers(id,owner_id,name) VALUES($1,$2,'Synthetic legacy provider')",
      [provider, owner],
    );
    const db = databaseFor(pg);
    assert.deepEqual(await migrate(db), [
      "001_platform.sql",
      "002_provider_memberships.sql",
      "003_minimal_child_profiles.sql",
      "004_saved_activities.sql",
      "005_paginated_list_indexes.sql",
    ]);
    const membership = (
      await pg.query<{ role: string; active: boolean }>(
        "SELECT role,active FROM app.provider_memberships WHERE provider_id=$1 AND user_id=$2",
        [provider, owner],
      )
    ).rows[0];
    assert.deepEqual(membership, { role: "owner", active: true });
    assert.deepEqual(await migrate(db), []);
    await pg.query(
      "UPDATE app.schema_migrations SET checksum='changed' WHERE name='001_platform.sql'",
    );
    await assert.rejects(() => migrate(db), /Applied migration changed/);
    assert.equal(
      (await pg.query("SELECT * FROM app.provider_memberships")).rows.length,
      1,
    );
  } finally {
    await pg.close();
  }
});
