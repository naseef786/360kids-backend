import test from "node:test";
import assert from "node:assert/strict";
import { connectionOptions } from "../src/database.js";

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
