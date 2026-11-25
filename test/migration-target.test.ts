import assert from "node:assert/strict";
import test from "node:test";
import { assertMigrationTarget } from "../src/migration-target.js";

test("migration command requires an explicit target", () => {
  assert.throws(() => assertMigrationTarget({}), /Set MIGRATION_TARGET/);
  assert.throws(() => assertMigrationTarget({ MIGRATION_TARGET: "unknown" }), /Set MIGRATION_TARGET/);
  assert.doesNotThrow(() => assertMigrationTarget({ MIGRATION_TARGET: "development" }));
  assert.doesNotThrow(() => assertMigrationTarget({ MIGRATION_TARGET: "staging" }));
});

test("production migration needs a separate exact confirmation", () => {
  assert.throws(() => assertMigrationTarget({ MIGRATION_TARGET: "production" }), /Production migrations require/);
  assert.throws(() => assertMigrationTarget({ MIGRATION_TARGET: "production", MIGRATION_PRODUCTION_CONFIRM: "yes" }), /Production migrations require/);
  assert.doesNotThrow(() => assertMigrationTarget({ MIGRATION_TARGET: "production", MIGRATION_PRODUCTION_CONFIRM: "APPLY_TO_PRODUCTION" }));
});
