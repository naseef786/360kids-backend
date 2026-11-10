import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Platform, type Actor } from "../src/platform.js";
import type { Database } from "../src/database.js";
import { randomUUID } from "node:crypto";
test("PostgreSQL booking lifecycle, ownership, idempotency, allocation and suppression", async () => {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL("../database/migrations/001_platform.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(
    await readFile(
      new URL(
        "../database/migrations/002_provider_memberships.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pg.exec(
    await readFile(
      new URL(
        "../database/migrations/003_minimal_child_profiles.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const db: Database = {
    connect: async () => ({
      query: async (sql, params = []) => {
        const r = await pg.query(sql, params);
        return {
          rows: r.rows as Record<string, any>[],
          rowCount: r.affectedRows,
        };
      },
      release() {},
    }),
  };
  const p = new Platform(db, true);
  const parent: Actor = { id: randomUUID(), role: "parent" },
    other: Actor = { id: randomUUID(), role: "parent" },
    provider: Actor = { id: randomUUID(), role: "provider" },
    admin: Actor = { id: randomUUID(), role: "admin" };
  try {
    for (const a of [parent, other, provider, admin]) {
      await p.me(a.id, "synthetic@example.invalid");
      await pg.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [
        a.id,
        a.role,
      ]);
    }
    const business = await p.apply(provider, {
      name: "Synthetic provider",
      description: "Synthetic test provider only",
    });
    await p.approve(admin, business.id, "approved");
    const activity = await p.createActivity(admin, {
      providerId: business.id,
      title: "Synthetic art session",
      description: "Test session",
      category: "Creative arts",
      area: "Dubai",
      minAge: 1,
      maxAge: 17,
      priceFils: 10000,
      policy: "Test policy for synthetic bookings.",
      published: true,
      startsAt: "2030-05-01T12:00:00Z",
      cutoffAt: "2030-04-30T12:00:00Z",
      capacity: 1,
    });
    const kid = await p.addChild(parent, {
      firstName: "Synthetic",
      surname: "Child",
      birthDate: "2018-01-01",
    });
    const kid2 = await p.addChild(other, {
      firstName: "Synthetic",
      surname: "Other",
      birthDate: "2018-01-01",
    });
    await assert.rejects(
      () =>
        p.request(other, "wrong-owner", {
          sessionId: activity.sessionId,
          childIds: [kid.id],
          policyAccepted: true,
        }),
      /own account/,
    );
    const body = {
      sessionId: activity.sessionId,
      childIds: [kid.id],
      policyAccepted: true,
    };
    const b = await p.request(parent, "same-request", body);
    assert.deepEqual(await p.request(parent, "same-request", body), b);
    await assert.rejects(
      () => p.request(parent, "same-request", { ...body, childIds: [kid2.id] }),
      /different request/,
    );
    const blocked = await p.bookings(other);
    assert.equal(blocked.length, 0);
    await assert.rejects(
      () =>
        p.act(other, "unauthorized", b.id, { action: "accept", version: 1 }),
      /not found/,
    );
    await p.act(provider, "accept-first", b.id, {
      action: "accept",
      version: 1,
    });
    assert.equal((await p.bookings(parent))[0].held, true);
    await assert.rejects(
      () =>
        p.act(provider, "stale-screen", b.id, {
          action: "decline",
          version: 1,
        }),
      /changed/,
    );
    const second = await p.request(other, "second-request", {
      sessionId: activity.sessionId,
      childIds: [kid2.id],
      policyAccepted: true,
    });
    await assert.rejects(
      () =>
        p.act(provider, "last-place", second.id, {
          action: "accept",
          version: 1,
        }),
      /Not enough/,
    );
    await p.act(parent, "proof-first", b.id, {
      action: "proof",
      version: 2,
      reference: "synthetic-reference",
    });
    assert.equal((await p.bookings(parent))[0].state, "PAYMENT_CHECKING");
    assert.equal(await p.expire(), 0);
    await assert.rejects(
      () =>
        p.act(provider, "wrong-verifier", b.id, {
          action: "verify",
          version: 3,
        }),
      /Admin/,
    );
    await p.act(admin, "verify-first", b.id, { action: "verify", version: 3 });
    await p.act(provider, "cancel-first", b.id, {
      action: "cancel",
      version: 4,
      reason: "Synthetic provider cancellation",
    });
    const refunds = await p.read("SELECT * FROM app.refunds");
    assert.equal(refunds[0].amount_fils, 10000);
    await p.act(provider, "offer-second", second.id, {
      action: "offer",
      version: 1,
      amountFils: 9000,
      reason: "Revised test price",
    });
    await p.act(other, "approve-offer", second.id, {
      action: "accept-offer",
      version: 2,
    });
    assert.equal((await p.bookings(other))[0].amount_fils, 9000);
    await pg.query(
      "UPDATE app.bookings SET payment_due_at=now()-interval '1 minute' WHERE id=$1",
      [second.id],
    );
    assert.equal(await p.expire(), 1);
    assert.equal(
      (await p.read("SELECT allocated FROM app.sessions"))[0].allocated,
      0,
    );
    const contacts = [{ phone: "+971500000000", name: "Synthetic contact" }];
    assert.equal(
      (await p.importContacts(admin, contacts, "test", false)).sendingEligible,
      0,
    );
    await p.importContacts(admin, contacts, "test", true);
    const c = (await p.read("SELECT * FROM app.contacts"))[0];
    await p.suppress(admin, c.id);
    await p.importContacts(admin, contacts, "test again", true);
    assert.equal(
      (await p.read("SELECT suppressed FROM app.contacts"))[0].suppressed,
      true,
    );
    await assert.rejects(() => p.operations(parent), /Admin/);
    const { createApp } = await import("../src/app.js");
    const server = createApp("http://localhost:3000", p, async (token) => {
      if (token !== "test-parent")
        throw Object.assign(new Error("Invalid token"), { status: 401 });
      return { id: parent.id, email: "synthetic@example.invalid" };
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) =>
      server.once("listening", () => resolve()),
    );
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}/v1`;
      assert.equal((await fetch(base + "/bookings")).status, 401);
      const auth = { Authorization: "Bearer test-parent" };
      assert.equal(
        (await fetch(base + "/bookings", { headers: auth })).status,
        200,
      );
      assert.equal(
        (await fetch(base + "/admin/operations", { headers: auth })).status,
        403,
      );
      assert.equal(
        (
          await fetch(base + "/children", {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({
              firstName: "Test",
              surname: "Only",
              birthDate: "2020-02-31",
            }),
          })
        ).status,
        422,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await pg.close();
  }
});
