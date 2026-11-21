import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authenticate } from "../src/routes.js";

test("Supabase service outages are retryable and do not masquerade as invalid credentials", async () => {
  const originalFetch = globalThis.fetch,
    url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = "https://auth.example.invalid/";
  process.env.SUPABASE_PUBLISHABLE_KEY = "synthetic-publishable-key";
  try {
    for (const status of [429, 500, 503]) {
      globalThis.fetch = async () =>
        new Response("Synthetic service error", { status });
      await assert.rejects(
        () => authenticate("synthetic-token"),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 503,
      );
    }
    globalThis.fetch = async () => {
      throw new TypeError("Synthetic connection failure");
    };
    await assert.rejects(
      () => authenticate("synthetic-token"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 503,
    );
    globalThis.fetch = async () =>
      new Response("<html>Synthetic proxy error</html>");
    await assert.rejects(
      () => authenticate("synthetic-token"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 503,
    );
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(
      () => authenticate("synthetic-token"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 401,
    );
    const userId = randomUUID();
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://auth.example.invalid/auth/v1/user");
      return new Response(
        JSON.stringify({ id: userId, email: "synthetic@example.invalid", email_confirmed_at: "2026-11-20T00:00:00Z" }),
      );
    };
    assert.equal((await authenticate("synthetic-token")).id, userId);
    assert.equal((await authenticate("synthetic-token")).emailVerified, true);
    const token = (claims: object) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
    assert.equal((await authenticate(token({sub:userId,aal:"aal2"}))).assuranceLevel,"aal2");
    assert.equal((await authenticate(token({sub:randomUUID(),aal:"aal2"}))).assuranceLevel,"aal1");
    assert.equal((await authenticate(token({sub:userId,user_metadata:{aal:"aal2"}}))).assuranceLevel,"aal1");
    globalThis.fetch = async () => new Response("{}",{status:401});
    await assert.rejects(() => authenticate(token({sub:userId,aal:"aal2"})),(error:unknown) => (error as {status:number}).status === 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = key;
  }
});
