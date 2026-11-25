import test from "node:test";
import assert from "node:assert/strict";
import { connectionOptions, transaction, type Database } from "../src/database.js";

test("Supabase database options require CA and hostname verification", () => {
  const config = connectionOptions({
    DATABASE_URL:
      "postgresql://postgres.example:synthetic@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require",
  });
  assert.equal(
    new URL(config.connectionString!).searchParams.has("sslmode"),
    false,
  );
  assert.equal(typeof config.ssl, "object");
  const tls = config.ssl as {
    rejectUnauthorized: boolean;
    ca: string;
    servername: string;
  };
  assert.equal(tls.rejectUnauthorized, true);
  assert.match(tls.ca, /BEGIN CERTIFICATE/);
  assert.equal(tls.servername, "aws-0-test.pooler.supabase.com");
});
test("remote weak TLS settings and missing certificates fail closed", () => {
  for (const mode of ["disable", "allow", "prefer", "no-verify"]) {
    assert.throws(
      () =>
        connectionOptions({
          DATABASE_URL: `postgresql://example.invalid/db?sslmode=${mode}`,
        }),
      /verified TLS/,
    );
  }
  assert.throws(
    () =>
      connectionOptions({
        DATABASE_URL: "postgresql://example.invalid/db",
        DATABASE_CA_CERT: "missing-root-certificate.crt",
      }),
    /certificate is unavailable/,
  );
  assert.throws(
    () => connectionOptions({ DATABASE_URL: "not-a-database-url" }),
    /connection string is invalid/,
  );
});
test("local development databases and public-CA hosts retain explicit behavior", () => {
  assert.equal(
    connectionOptions({ DATABASE_URL: "postgresql://localhost/local" }).ssl,
    false,
  );
  const config = connectionOptions({
    DATABASE_URL: "postgresql://example.invalid/db",
  });
  assert.equal(
    (config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized,
    true,
  );
});

for (const stage of ["BEGIN", "callback", "COMMIT"] as const) {
  for (const rollbackFails of [false, true]) {
    test(`transaction preserves ${stage} error when rollback ${rollbackFails ? "fails" : "succeeds"}`, async () => {
      const root = new Error("Synthetic root failure");
      const calls: string[] = [], releases: (boolean | undefined)[] = [];
      const db: Database = { connect: async () => ({
        query: async sql => {
          calls.push(sql);
          if (sql === stage) throw root;
          if (sql === "ROLLBACK" && rollbackFails) throw new Error("Synthetic rollback failure");
          return { rows: [] };
        },
        release: destroy => { releases.push(destroy); },
      }) };
      await assert.rejects(() => transaction(db, async () => {
        if (stage === "callback") throw root;
      }), error => error === root);
      assert.equal(calls.at(-1), "ROLLBACK");
      assert.deepEqual(releases, [rollbackFails]);
    });
  }
}

test("fatal connection failures evict even when rollback succeeds", async () => {
  for (const properties of [{code:"08006"}, {code:"57P01"}, {code:"ECONNRESET"}, {severity:"FATAL"}, {severity:"PANIC"}, {message:"Connection terminated unexpectedly"}]) {
    const root = Object.assign(new Error("Synthetic failure"), properties);
    let destroyed: boolean | undefined;
    const db: Database = { connect: async () => ({
      query: async () => ({rows:[]}), release: value => { destroyed = value; },
    }) };
    await assert.rejects(() => transaction(db, async () => { throw root; }), error => error === root);
    assert.equal(destroyed, true);
  }
});

test("successful transactions commit and release once without eviction", async () => {
  const calls: string[] = [], releases: (boolean | undefined)[] = [];
  const db: Database = { connect: async () => ({
    query: async sql => { calls.push(sql); return {rows:[]}; },
    release: value => { releases.push(value); },
  }) };
  assert.equal(await transaction(db, async () => 42), 42);
  assert.deepEqual(calls, ["BEGIN", "COMMIT"]);
  assert.deepEqual(releases, [false]);
});

test("connection acquisition failure preserves the error without cleanup", async () => {
  const root = new Error("Synthetic pool failure");
  await assert.rejects(() => transaction({connect:async () => { throw root; }}, async () => 1), error => error === root);
});
