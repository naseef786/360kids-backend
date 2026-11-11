import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createTestDatabase } from "./helpers.js";
import { migrate } from "../src/migrations.js";
import { Platform, type Actor } from "../src/platform.js";
import { NotificationService } from "../src/notifications.js";
import { createApp } from "../src/app.js";

test("migrations are repeatable, checksummed and keep browser roles outside the private schema", async () => {
  const { pg, db } = await createTestDatabase();
  try {
    assert.deepEqual(await migrate(db), []);
    await pg.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; GRANT USAGE ON SCHEMA app TO anon,authenticated; GRANT SELECT ON ALL TABLES IN SCHEMA app TO anon,authenticated;",
    );
    // Rehearse upgrading a project where browser roles had accidental grants.
    await pg.query("DELETE FROM app.schema_migrations WHERE name=$1", [
      "004_private_access_indexes.sql",
    ]);
    assert.deepEqual(await migrate(db), [
      "004_private_access_indexes.sql",
    ]);
    for (const role of ["anon", "authenticated"]) {
      const result = await pg.query(
        "SELECT has_schema_privilege($1,'app','USAGE') AS allowed",
        [role],
      );
      assert.equal((result.rows[0] as { allowed: boolean }).allowed, false);
    }
    await pg.query(
      "UPDATE app.schema_migrations SET checksum='synthetic-mismatch' WHERE name=$1",
      ["001_platform.sql"],
    );
    await assert.rejects(
      () => migrate(db),
      /Applied migration changed/,
    );
    assert.equal(
      (
        await pg.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM app.schema_migrations",
        )
      ).rows[0].total,
      8,
    );
  } finally {
    await pg.close();
  }
});

test("readiness rejects missing migrations, and an injected auth service enables only configured finance", async () => {
  const { pg, db } = await createTestDatabase();
  const p = new Platform(db, false);
  const server = createApp("http://localhost:3000", p, async () => ({
    id: randomUUID(),
    email: "synthetic@example.invalid",
  })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const ready = await fetch(url + "/health/ready");
    assert.equal(ready.status, 200);
    assert.match(ready.headers.get("cache-control") ?? "", /no-store/);
    const status = await (await fetch(url + "/v1/status")).json();
    assert.equal(status.bookingsAvailable, true);
    assert.equal(status.financeEnabled, false);
    await pg.query("DELETE FROM app.schema_migrations WHERE name=$1", [
      "004_private_access_indexes.sql",
    ]);
    assert.equal(await p.ready(), false);
    const unready = createApp("http://localhost:3000", p, async () => ({
      id: randomUUID(),
      email: "synthetic@example.invalid",
    })).listen(0, "127.0.0.1");
    await once(unready, "listening");
    try {
      const response = await fetch(
        "http://127.0.0.1:" +
          (unready.address() as { port: number }).port +
          "/health/ready",
      );
      assert.equal(response.status, 503);
      assert.equal((await response.json()).database, false);
    } finally {
      unready.closeAllConnections();
      await new Promise<void>((resolve) => unready.close(() => resolve()));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
  }
});

test("suspended providers cannot publish or acquire places; operational notifications reach other admins", async () => {
  const { pg, db } = await createTestDatabase();
  const p = new Platform(db),
    feed = new NotificationService(db);
  const parent: Actor = { id: randomUUID(), role: "parent" },
    provider: Actor = { id: randomUUID(), role: "provider" },
    admin: Actor = { id: randomUUID(), role: "admin" },
    admin2: Actor = { id: randomUUID(), role: "admin" };
  try {
    for (const actor of [parent, provider, admin, admin2]) {
      await p.me(actor.id, "synthetic@example.invalid");
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1", [
        actor.id,
        actor.role,
      ]);
    }
    const business = await p.apply(provider, {
      name: "Synthetic provider",
      description: "Synthetic provider for audit testing",
    });
    const synced = await p.me(provider.id, "updated-synthetic@example.invalid");
    assert.equal(synced.email, "updated-synthetic@example.invalid");
    assert.equal(synced.role, "provider");
    const activityInput = {
      providerId: business.id,
      title: "Synthetic session",
      description: "Synthetic session for audit testing",
      category: "Sports",
      area: "Dubai",
      minAge: 1,
      maxAge: 17,
      priceFils: 10000,
      policy: "Synthetic test policy only.",
      published: true,
      startsAt: "2030-05-01T12:00:00Z",
      cutoffAt: "2030-04-30T12:00:00Z",
      capacity: 5,
    };
    await assert.rejects(
      () => p.createActivity(admin, activityInput),
      /approved providers/,
    );
    await p.approve(admin, business.id, "approved");
    const activity = await p.createActivity(admin, activityInput);
    const child = await p.addChild(parent, {
      firstName: "Synthetic",
      surname: "Child",
      birthDate: "2018-01-01",
    });
    assert.equal(new Date((await p.children(parent))[0].birth_date).toISOString().slice(0,10), "2018-01-01");
    const booking = await p.request(parent, "audit-request", {
      sessionId: activity.sessionId,
        activityVersion: 1,
      childIds: [child.id],
      policyAccepted: true,
    });
    await p.act(provider, "audit-offer", booking.id, {
      action: "offer",
      version: 1,
      amountFils: 9500,
      reason: "Synthetic offer",
    });
    await p.approve(admin, business.id, "suspended", "Synthetic suspension");
    await assert.rejects(
      () =>
        p.act(parent, "audit-accept", booking.id, {
          action: "accept-offer",
          version: 2,
        }),
      /not currently accepting/,
    );
    const stored = (await p.bookings(parent))[0];
    assert.equal(stored.state, "OFFER_PENDING");
    assert.equal(stored.held, false);
    assert.equal(
      (
        await p.read("SELECT allocated FROM app.sessions WHERE id=$1", [
          activity.sessionId,
        ])
      )[0].allocated,
      0,
    );
    await p.approve(admin, business.id, "approved");
    await p.read("UPDATE app.provider_memberships SET active=false WHERE user_id=$1", [provider.id]);
    await assert.rejects(() => p.act(provider,"revoked-provider",booking.id,{action:"decline",version:2}), /not found/);
    assert.equal((await feed.list(provider)).items.some(n => n.subject_id === booking.id),false);
    await p.saveContent(admin, "about", {
      title: "Synthetic title",
      body: "Synthetic reviewed content.",
      published: false,
      version: 0,
    });
    assert.ok(
      (await feed.list(admin2)).items.some((n) => n.event === "content.updated"),
    );
    const familyFeed = await feed.list(parent);
    assert.equal(
      familyFeed.items.some((n) => n.event === "content.updated"),
      false,
    );
    assert.equal(
      (await feed.list(admin2)).items.some((n) => n.event === "child.created"),
      false,
    );
  } finally {
    await pg.close();
  }
});
