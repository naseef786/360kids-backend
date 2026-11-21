import assert from "node:assert/strict";
import test from "node:test";
import { assertSyntheticTarget } from "../src/synthetic-target.js";

const ref = "abcdefghijklmnopqrst";
const fixture = {
  SYNTHETIC_TEST_TARGET: "development",
  SYNTHETIC_TEST_PROJECT_REF: ref,
  SUPABASE_URL: `https://${ref}.supabase.co`,
  DATABASE_URL: `postgresql://postgres.${ref}:example@aws-0-example.pooler.supabase.com:5432/postgres`,
};

test("synthetic fixtures fail closed without explicit project matching", () => {
  assert.throws(() => assertSyntheticTarget({}), /explicit development target/);
  assert.throws(() => assertSyntheticTarget({ ...fixture, NODE_ENV: "production" }), /explicit development target/);
  assert.throws(() => assertSyntheticTarget({ ...fixture, SYNTHETIC_TEST_PROJECT_REF: "otherprojectref" }), /do not match/);
  assert.throws(() => assertSyntheticTarget({ ...fixture, DATABASE_URL: `postgresql://postgres.otherprojectref:example@aws-0-example.pooler.supabase.com:5432/postgres` }), /do not match/);
  assert.throws(() => assertSyntheticTarget({ ...fixture, SUPABASE_URL: "https://otherprojectref.supabase.co" }), /do not match/);
  assert.doesNotThrow(() => assertSyntheticTarget(fixture));
  assert.doesNotThrow(() => assertSyntheticTarget({ ...fixture, DATABASE_URL: `postgresql://postgres:example@db.${ref}.supabase.co:5432/postgres` }));
});
