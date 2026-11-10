import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createTestDatabase } from "./helpers.js";
import { Platform, type Actor } from "../src/platform.js";
import { createApp } from "../src/app.js";

test("HTTP family request, partner acceptance, finance gate, scoped notifications and cancellation", async () => {
  const { pg, db } = await createTestDatabase(),
    p = new Platform(db);
  const actors: Record<string, Actor> = {
    parent: { id: randomUUID(), role: "parent" },
    provider: { id: randomUUID(), role: "provider" },
    other: { id: randomUUID(), role: "parent" },
    admin: { id: randomUUID(), role: "admin" },
  };
  for (const a of Object.values(actors)) {
    await p.me(a.id, "synthetic@example.invalid");
    await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1", [a.id, a.role]);
  }
  const provider = await p.apply(actors.provider, {
    name: "Synthetic provider",
    description: "Synthetic HTTP fixture only",
  });
  await p.approve(actors.admin, provider.id, "approved");
  const activity = await p.createActivity(actors.admin, {
    providerId: provider.id,
    title: "Synthetic activity",
    description: "Synthetic activity for HTTP tests",
    category: "Sports",
    area: "Dubai",
    minAge: 1,
    maxAge: 17,
    priceFils: 10000,
    policy: "Synthetic test terms only.",
    published: true,
    startsAt: "2030-05-01T12:00:00Z",
    cutoffAt: "2030-04-30T12:00:00Z",
    capacity: 2,
  });
  const child = await p.addChild(actors.parent, {
    firstName: "Synthetic",
    surname: "Child",
    birthDate: "2018-01-01",
  });
  const server = createApp("http://localhost:3000", p, async (token) => {
    if (!actors[token])
      throw Object.assign(new Error("Synthetic invalid identity"), {
        status: 401,
      });
    return { id: actors[token].id, email: "synthetic@example.invalid" };
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
  const call = (
    path: string,
    token: string,
    body?: unknown,
    key = randomUUID(),
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "Idempotency-Key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const body = {
        sessionId: activity.sessionId,
        activityVersion: 1,
        childIds: [child.id],
        policyAccepted: true,
      },
      key = randomUUID();
    const listing = (await p.managementCatalog(actors.admin))[0];
    await p.editActivity(actors.admin, activity.id, {
      version: listing.version,
      title: listing.title,
      description: listing.description,
      category: listing.category,
      area: listing.area,
      minAge: listing.min_age,
      maxAge: listing.max_age,
      priceFils: 12000,
      policy: "Updated synthetic terms.",
      published: true,
    });
    const stale = await call("/bookings", "parent", body, key);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).message, /price or terms changed/);
    assert.equal((await p.bookings(actors.parent)).length, 0);
    body.activityVersion = (await p.catalog())[0].version;
    assert.equal(body.activityVersion, 2);
    const first = await call("/bookings", "parent", body, key);
    assert.equal(first.status, 201);
    const booking = await first.json();
    const replay = await call("/bookings", "parent", body, key);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).id, booking.id);
    const duplicate = await call("/bookings", "parent", body);
    assert.equal(duplicate.status, 409);
    assert.match(
      (await duplicate.json()).message,
      /already has an active request/,
    );
    assert.deepEqual(await (await call("/bookings", "other")).json(), []);
    const unauthorized = await call(
      "/bookings/" + booking.id + "/actions",
      "other",
      { action: "accept", version: 1 },
    );
    assert.equal(unauthorized.status, 404);
    const accepted = await call(
      "/bookings/" + booking.id + "/actions",
      "provider",
      { action: "accept", version: 1 },
    );
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).state, "PAYMENT_DUE");
    const parentBookings = await (await call("/bookings", "parent")).json();
    assert.equal(parentBookings[0].amount_fils, 12000);
    assert.equal(parentBookings[0].snapshot.listingVersion, 2);
    assert.equal(parentBookings[0].held, true);
    assert.equal(parentBookings[0].state, "PAYMENT_DUE");
    assert.equal(JSON.stringify(parentBookings).includes("birth_date"), false);
    const proof = await call("/bookings/" + booking.id + "/actions", "parent", {
      action: "proof",
      version: 2,
      reference: "synthetic-reference",
    });
    assert.equal(proof.status, 409);
    const notices = await (await call("/notifications", "provider")).json();
    assert.ok(
      notices.items.some(
        (n: { event: string }) => n.event === "request.submitted",
      ),
    );
    assert.equal(
      (await (await call("/notifications", "other")).json()).total,
      0,
    );
    assert.equal(
      (await call("/bookings/" + booking.id + "/history", "other")).status,
      404,
    );
    const cancelled = await call(
      "/bookings/" + booking.id + "/actions",
      "parent",
      { action: "cancel", version: 2, reason: "Synthetic cancellation test" },
    );
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).state, "CANCELLED");
    assert.equal(
      (
        await p.read("SELECT allocated FROM app.sessions WHERE id=$1", [
          activity.sessionId,
        ])
      )[0].allocated,
      0,
    );
    assert.equal(
      (await call("/notifications/read", "provider", { all: true })).status,
      200,
    );
    assert.equal(
      (await (await call("/notifications", "provider")).json()).unread,
      0,
    );
    const ownChild = await p.addChild(actors.provider, {
      firstName: "Synthetic",
      surname: "Provider family",
      birthDate: "2018-01-01",
    });
    const ownBooking = await p.request(
      actors.provider,
      "synthetic-own-family",
      {
        sessionId: activity.sessionId,
        activityVersion: 2,
        childIds: [ownChild.id],
        policyAccepted: true,
      },
    );
    const providerFeed = await (
      await call("/notifications", "provider")
    ).json();
    assert.equal(
      providerFeed.items.find(
        (notice: { subject_id: string }) => notice.subject_id === ownBooking.id,
      ).workspace,
      "family",
    );
    const family = await (
      await call("/bookings?scope=family", "provider")
    ).json();
    assert.equal(family.length, 1);
    assert.equal(family[0].parent_id, actors.provider.id);
    assert.equal(
      (await (await call("/bookings?scope=provider", "provider")).json())
        .length,
      2,
    );
    assert.equal(
      (await (await call("/bookings?scope=family", "admin")).json()).length,
      0,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
  }
});
