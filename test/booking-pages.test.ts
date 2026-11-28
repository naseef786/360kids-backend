import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createTestDatabase } from "./helpers.js";
import { Platform, type Actor } from "../src/platform.js";
import { createApp } from "../src/app.js";
import { bookingPageQuery } from "../src/booking-pages.js";

test("booking pages reach beyond 200 with stable cursors, scoped counts, literal search and current-role access", async () => {
  const { pg, db } = await createTestDatabase(),
    p = new Platform(db);
  const actors: Record<string, Actor> = {
    parent: { id: randomUUID(), role: "parent" },
    other: { id: randomUUID(), role: "parent" },
    provider: { id: randomUUID(), role: "provider" },
    secondProvider: { id: randomUUID(), role: "provider" },
    admin: { id: randomUUID(), role: "admin" },
  };
  try {
    for (const actor of Object.values(actors)) {
      await p.me(actor.id, "synthetic@example.invalid");
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1", [
        actor.id,
        actor.role,
      ]);
    }
    const provider = await p.apply(actors.provider, {
      name: "Synthetic provider",
      description: "Synthetic pagination fixture",
    });
    const secondProvider = await p.apply(actors.secondProvider, {
      name: "Synthetic other provider",
      description: "Synthetic pagination fixture",
    });
    await p.approve(actors.admin, provider.id, "approved");
    await p.approve(actors.admin, secondProvider.id, "approved");
    const activity = await p.createActivity(actors.admin, {
      providerId: provider.id,
      title: "Synthetic art",
      description: "Synthetic pagination data only",
      category: "Creative arts",
      area: "Dubai",
      minAge: 1,
      maxAge: 17,
      priceFils: 10000,
      policy: "Synthetic policy",
      published: true,
      startsAt: "2035-05-01T12:00:00Z",
      cutoffAt: "2035-04-30T12:00:00Z",
      capacity: 500,
    });
    const secondActivity = await p.createActivity(actors.admin, {
      providerId: secondProvider.id,
      title: "Synthetic other",
      description: "Synthetic pagination data only",
      category: "Creative arts",
      area: "Dubai",
      minAge: 1,
      maxAge: 17,
      priceFils: 10000,
      policy: "Synthetic policy",
      published: true,
      startsAt: "2035-05-01T12:00:00Z",
      cutoffAt: "2035-04-30T12:00:00Z",
      capacity: 500,
    });
    // Bulk fixtures exercise real SQL at a size exceeding the legacy cap. No customer data.
    const rows = Array.from({ length: 308 }, (_, i) => ({
      id: randomUUID(),
      parent_id:
        i < 260
          ? actors.parent.id
          : i < 290
            ? actors.other.id
            : i < 297
              ? actors.provider.id
              : actors.other.id,
      provider_id: i < 290 ? provider.id : secondProvider.id,
      session_id: i < 290 ? activity.sessionId : secondActivity.sessionId,
      state: i < 260 ? (i % 2 ? "CANCELLED" : "CONFIRMED") : "REQUESTED",
      created_at:
        i < 306 ? "2030-01-01T12:00:00.000001Z" : "2030-01-01T12:00:00.000002Z",
      snapshot: {
        title: i === 0 ? "Literal %_ workshop" : "Synthetic art",
        provider: i < 290 ? "Synthetic provider" : "Synthetic other provider",
        startsAt: "2035-05-01T12:00:00Z",
        policy: "Synthetic policy",
        children: [
          { id: randomUUID(), firstName: "Synthetic", surname: "Child" },
        ],
      },
    }));
    await p.read(
      `INSERT INTO app.bookings(id,parent_id,provider_id,session_id,state,quantity,amount_fils,snapshot,response_due_at,created_at)
      SELECT id,parent_id,provider_id,session_id,state,1,10000,snapshot,'2035-04-30T12:00:00Z',created_at
      FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,parent_id uuid,provider_id uuid,session_id uuid,state text,snapshot jsonb,created_at timestamptz)`,
      [JSON.stringify(rows)],
    );
    const query = (overrides = {}) =>
      bookingPageQuery.parse({ scope: "family", limit: 17, ...overrides });
    let page = await p.bookingPage(actors.parent, query());
    assert.equal(page.total, 260);
    assert.equal(page.counts.CONFIRMED, 130);
    assert.equal(page.counts.CANCELLED, 130);
    assert.equal(page.items.length, 17);
    const ids = page.items.map((b: { id: string }) => b.id);
    const firstCursor = page.nextCursor!;
    assert.ok(firstCursor);
    assert.equal(JSON.stringify(page.items).includes("birth_date"), false);
    // A newer insert must not shift existing pages or repeat the boundary record.
    const inserted = {
      ...rows[0],
      id: randomUUID(),
      created_at: "2031-01-01T00:00:00Z",
    };
    await p.read(
      `INSERT INTO app.bookings(id,parent_id,provider_id,session_id,state,quantity,amount_fils,snapshot,response_due_at,created_at)
      VALUES($1,$2,$3,$4,'CONFIRMED',1,10000,$5,'2035-04-30T12:00:00Z',$6)`,
      [
        inserted.id,
        inserted.parent_id,
        inserted.provider_id,
        inserted.session_id,
        JSON.stringify(inserted.snapshot),
        inserted.created_at,
      ],
    );
    while (page.nextCursor) {
      page = await p.bookingPage(
        actors.parent,
        query({ cursor: page.nextCursor }),
      );
      ids.push(...page.items.map((b: { id: string }) => b.id));
    }
    assert.equal(ids.length, 260);
    assert.equal(new Set(ids).size, 260);
    assert.equal(ids.includes(inserted.id), false);
    assert.deepEqual(
      ids,
      rows
        .slice(0, 260)
        .map((b) => b.id)
        .sort()
        .reverse(),
    );
    const refreshed = await p.bookingPage(actors.parent, query());
    assert.equal(refreshed.total, 261);
    assert.equal(refreshed.items[0].id, inserted.id);
    assert.equal(
      (await p.bookingPage(actors.parent, query({ search: "%_" }))).total,
      2,
    );
    assert.equal(
      (
        await p.bookingPage(
          actors.parent,
          query({ search: "no synthetic match" }),
        )
      ).total,
      0,
    );
    assert.equal(
      (await p.bookingPage(actors.parent, query({ state: "CONFIRMED" }))).total,
      131,
    );
    assert.equal(
      (await p.bookingPage(actors.parent, query({ state: "REQUESTED" }))).total,
      0,
    );
    assert.equal(
      (await p.bookingPage(actors.provider, query({ scope: "provider" })))
        .total,
      291,
    );
    assert.equal((await p.bookingPage(actors.provider, query())).total, 7);
    assert.equal(
      (await p.bookingPage(actors.provider, query({ scope: "all" }))).total,
      298,
    );
    assert.equal(
      (await p.bookingPage(actors.admin, query({ scope: "all" }))).total,
      309,
    );
    assert.equal(
      (
        await p.bookingPage(
          actors.provider,
          query({ scope: "provider", state: "attention" }),
        )
      ).total,
      30,
    );
    const revoked = { ...actors.provider, role: "parent" };
    assert.equal(
      (await p.bookingPage(revoked, query({ scope: "provider" }))).total,
      0,
    );
    assert.equal(
      (await p.bookingPage(revoked, query({ scope: "all" }))).total,
      7,
    );
    await assert.rejects(
      () =>
        p.bookingPage(
          actors.parent,
          query({ cursor: firstCursor, state: "CONFIRMED" }),
        ),
      /current filters/,
    );
    await assert.rejects(
      () => p.bookingPage(actors.parent, query({ cursor: "invalid_cursor" })),
      /Invalid booking page/,
    );
    const server = createApp("http://localhost:3000", p, async () => ({
      id: actors.provider.id,
      email: "synthetic@example.invalid",
    })).listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint =
      "http://127.0.0.1:" +
      (server.address() as { port: number }).port +
      "/v1/bookings/page?scope=provider";
    const headers = { Authorization: "Bearer synthetic" };
    try {
      assert.equal(
        (await (await fetch(endpoint, { headers })).json()).total,
        291,
      );
      await p.read("UPDATE app.profiles SET role='parent' WHERE id=$1", [
        actors.provider.id,
      ]);
      const demotedPage = await (await fetch(endpoint, { headers })).json();
      assert.equal(demotedPage.total, 0);
      assert.deepEqual(demotedPage.counts, {});
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The final two rows differ only by PostgreSQL microseconds.
    const micro = await p.bookingPage(actors.other, query({ limit: 1 }));
    const afterMicro = await p.bookingPage(
      actors.other,
      query({ limit: 1, cursor: micro.nextCursor }),
    );
    assert.notEqual(afterMicro.items[0].id, micro.items[0].id);
    assert.ok(afterMicro.nextCursor);
  } finally {
    await pg.close();
  }
});

test("booking page HTTP validates bounded queries and rechecks the signed-in profile role", async () => {
  const { pg, db } = await createTestDatabase(),
    p = new Platform(db);
  const id = randomUUID();
  await p.me(id, "synthetic@example.invalid");
  const server = createApp("http://localhost:3000", p, async () => ({
    id,
    email: "synthetic@example.invalid",
  })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base =
    "http://127.0.0.1:" +
    (server.address() as { port: number }).port +
    "/v1/bookings/page";
  const headers = { Authorization: "Bearer synthetic" };
  try {
    assert.equal((await fetch(base)).status, 401);
    for (const query of [
      "limit=101",
      "limit=0",
      "limit=1.5",
      "state=NOT_A_STATE",
      "scope=unknown",
      "cursor=bad!",
      "cursor=",
      "search=" + "x".repeat(101),
    ])
      assert.equal(
        (await fetch(base + "?" + query, { headers })).status,
        422,
        query,
      );
    const response = await fetch(base + "?scope=provider", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      items: [],
      total: 0,
      counts: {},
      nextCursor: null,
    });
    assert.match(response.headers.get("cache-control")!, /no-store/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
  }
});
