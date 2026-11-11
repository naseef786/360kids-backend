import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { Platform, type Actor } from "../src/platform.js";
import { databaseFor } from "./support/database.js";
import { migrate } from "../src/migrations.js";
import { createApp } from "../src/app.js";
import { authenticate } from "../src/routes.js";

test("organization scopes, dual roles, revocation and authenticated detail APIs", async () => {
  const pg = new PGlite();
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    const db = databaseFor(pg);
    await migrate(db);
    const p = new Platform(db);
    const actors: Record<string, Actor> = {
      parent: { id: randomUUID(), role: "parent" },
      other: { id: randomUUID(), role: "parent" },
      owner: { id: randomUUID(), role: "provider" },
      otherOwner: { id: randomUUID(), role: "provider" },
      staff: { id: randomUUID(), role: "parent" },
      admin: { id: randomUUID(), role: "admin" },
    };
    for (const [label, a] of Object.entries(actors)) {
      await p.me(a.id, `${label}@example.invalid`);
      await pg.query("UPDATE app.profiles SET role=$2 WHERE id=$1", [
        a.id,
        a.role,
      ]);
    }
    const organization = await p.apply(actors.owner, {
      name: "Synthetic art provider",
      description: "Synthetic test organization",
    });
    const otherOrganization = await p.apply(actors.otherOwner, {
      name: "Synthetic music provider",
      description: "Other test organization",
    });
    await p.approve(actors.admin, organization.id, "approved");
    await p.approve(actors.admin, otherOrganization.id, "approved");
    await p.setMember(actors.owner, organization.id, actors.staff.id, true);
    await p.setMember(actors.owner, organization.id, actors.staff.id, true);
    const staffIdentity = await p.me(actors.staff.id, "staff@example.invalid");
    assert.deepEqual(staffIdentity.roles, ["parent", "partner"]);
    assert.equal((await p.providers(actors.staff)).length, 1);
    assert.equal((await p.providers(actors.staff))[0].id, organization.id);
    assert.equal(
      (await p.me(actors.admin.id, "admin@example.invalid")).roles.includes(
        "superadmin",
      ),
      true,
    );
    await assert.rejects(
      () =>
        p.setMember(actors.otherOwner, organization.id, actors.other.id, true),
      /not found/,
    );
    await assert.rejects(
      () => p.members(actors.staff, organization.id),
      /not found/,
    );
    await assert.rejects(
      () => p.setMember(actors.owner, organization.id, actors.owner.id, false),
      /owner cannot/,
    );
    assert.equal((await p.members(actors.owner, organization.id)).length, 2);

    const draft = {
      providerId: organization.id,
      title: "Synthetic art session",
      description: "Synthetic activity for tests",
      category: "Arts",
      area: "Dubai",
      minAge: 3,
      maxAge: 12,
      priceFils: 10000,
      policy: "Synthetic cancellation policy",
      published: true,
      startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      cutoffAt: new Date(Date.now() + 6 * 86400000).toISOString(),
      capacity: 5,
    };
    const activity = await p.createActivity(actors.admin, draft);
    const hidden = await p.createActivity(actors.admin, {
      ...draft,
      published: false,
    });
    const otherActivity = await p.createActivity(actors.admin, {
      ...draft,
      title: "Synthetic music session",
      category: "Music",
      providerId: otherOrganization.id,
    });
    assert.equal(
      (await p.catalog({ q: "ART", age: 6, area: "dubai" })).length,
      1,
    );
    assert.equal((await p.catalog({ q: "' OR 1=1 --" })).length, 0);
    assert.equal((await p.catalog({ age: 17 })).length, 0);
    assert.equal((await p.catalog({ limit: 1 })).length, 1);
    await assert.rejects(() => p.activity(hidden.id), /not found/);
    const child = await p.addChild(actors.parent, {
      firstName: "Synthetic",
      surname: "Child",
      birthDate: `${new Date().getUTCFullYear() - 6}-01-01`,
    });
    const ageOnly = await p.addChild(actors.staff, {
      firstName: "Synthetic age profile",
      ageYears: 6,
    });
    const minimal = (await p.children(actors.staff))[0];
    assert.equal(minimal.birth_date, null);
    assert.equal(minimal.age_years, 6);
    assert.equal(minimal.surname, "");
    const ownBooking = await p.request(actors.staff, "age-only-request", {
      sessionId: activity.sessionId,
          activityVersion: 1,
      childIds: [ageOnly.id],
      policyAccepted: true,
    });
    const ownOffer = {
      action: "offer",
      version: 1,
      amountFils: 9000,
      reason: "Synthetic own-family offer",
    };
    await p.act(actors.staff, "own-family-offer", ownBooking.id, ownOffer);
    const narrow = await p.createActivity(actors.admin, {
      ...draft,
      minAge: 6,
      maxAge: 6,
    });
    await assert.rejects(
      () =>
        p.request(actors.staff, "uncertain-age-request", {
          sessionId: narrow.sessionId,
          activityVersion: 1,
          childIds: [ageOnly.id],
          policyAccepted: true,
        }),
      /exact birth date/,
    );
    await assert.rejects(
      () =>
        p.updateChild(actors.other, ageOnly.id, {
          firstName: "Wrong owner",
          ageYears: 6,
        }),
      /not found/,
    );
    await p.updateChild(actors.staff, ageOnly.id, {
      firstName: "Synthetic updated",
      birthDate: `${new Date().getUTCFullYear() - 6}-01-01`,
    });
    assert.equal((await p.children(actors.staff))[0].age_years, null);
    const booking = await p.request(actors.parent, "organization-request", {
      sessionId: activity.sessionId,
          activityVersion: 1,
      childIds: [child.id],
      policyAccepted: true,
    });
    assert.equal((await p.booking(actors.staff, booking.id)).id, booking.id);
    assert.equal((await p.bookings(actors.otherOwner)).length, 0);
    await assert.rejects(
      () => p.booking(actors.other, booking.id),
      /not found/,
    );
    await assert.rejects(
      () => p.booking(actors.otherOwner, booking.id),
      /not found/,
    );
    const offer = {
      action: "offer",
      version: 1,
      amountFils: 9000,
      reason: "Synthetic offer",
    };
    await p.act(actors.staff, "staff-offer-key", booking.id, offer);
    await p.setMember(actors.owner, organization.id, actors.staff.id, false);
    assert.deepEqual(
      (await p.me(actors.staff.id, "staff@example.invalid")).roles,
      ["parent"],
    );
    assert.equal((await p.bookings(actors.staff)).length, 1); // Their own parent booking remains visible.
    await assert.rejects(
      () => p.booking(actors.staff, booking.id),
      /not found/,
    );
    await assert.rejects(
      () => p.act(actors.staff, "staff-offer-key", booking.id, offer),
      /not found/,
    );
    await assert.rejects(
      () => p.act(actors.staff, "own-family-offer", ownBooking.id, ownOffer),
      /Provider access/,
    );
    await p.setMember(actors.owner, organization.id, actors.staff.id, true);

    server = createApp("http://localhost:3000", p, async (token) => {
      const a = actors[token];
      if (!a) throw Object.assign(new Error("Invalid token"), { status: 401 });
      return { id: a.id, email: `${token}@example.invalid` };
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = (who: string) => ({
      Authorization: `Bearer ${who}`,
      "Content-Type": "application/json",
    });
    const firstPage = await (
      await fetch(`${base}/v1/activities?pageSize=1`)
    ).json();
    const secondPage = await (
      await fetch(`${base}/v1/activities?pageSize=1&page=2`)
    ).json();
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.pages, 3);
    assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
    const beyond = await (
      await fetch(`${base}/v1/activities?pageSize=1&page=99`)
    ).json();
    assert.equal(beyond.items.length, 0);
    assert.equal(beyond.total, 3);
    assert.equal(
      (await (await fetch(`${base}/v1/activities?q=missing`)).json()).total,
      0,
    );
    for (const suffix of [
      "page=0",
      "page=-1",
      "page=1.5",
      "pageSize=0",
      "pageSize=101",
      "offset=100",
      "limit=100",
    ])
      assert.equal(
        (await fetch(`${base}/v1/activities?${suffix}`)).status,
        422,
      );
    await p.save(actors.parent, activity.id, true);
    await p.save(actors.parent, activity.id, true);
    assert.equal(
      (await p.list("saved", actors.parent, { page: 1, pageSize: 1 })).total,
      1,
    );
    assert.equal(
      (await p.list("saved", actors.other, { page: 1, pageSize: 1 })).total,
      0,
    );
    await assert.rejects(
      () => p.save(actors.parent, hidden.id, true),
      /not found/,
    );
    const partnerDraft = await p.createActivity(actors.staff, {
      ...draft,
      published: false,
    });
    await assert.rejects(
      () => p.createActivity(actors.parent, { ...draft, published: false }),
      /partner access/,
    );
    await assert.rejects(
      () => p.publishActivity(actors.staff, partnerDraft.id, true),
      /Admin/,
    );
    await p.publishActivity(actors.admin, partnerDraft.id, true);
    assert.equal((await p.activity(partnerDraft.id)).published, true);
    await p.publishActivity(actors.admin, partnerDraft.id, false);
    await p.updateActivity(actors.admin, partnerDraft.id, {
      ...draft,
      title: "Updated draft",
    });
    await assert.rejects(
      () => p.updateActivity(actors.staff, partnerDraft.id, draft),
      /Admin/,
    );
    const correction = await p.correction(
      actors.staff,
      partnerDraft.id,
      "Synthetic correction request",
    );
    await p.reviewCorrection(
      actors.admin,
      correction.id,
      "resolved",
      "Synthetic correction applied",
    );
    await assert.rejects(
      () =>
        p.reviewCorrection(
          actors.admin,
          correction.id,
          "rejected",
          "Already done",
        ),
      /already reviewed/,
    );
    await p.addSession(actors.admin, activity.id, {
      startsAt: draft.startsAt,
      cutoffAt: draft.cutoffAt,
      capacity: 2,
    });
    const sessions = await (
      await fetch(`${base}/v1/activities/${activity.id}/sessions?pageSize=1`)
    ).json();
    assert.equal(sessions.items.length, 1);
    assert.equal(sessions.total, 2);
    assert.equal(
      (await fetch(`${base}/v1/activities/${hidden.id}/sessions`)).status,
      404,
    );
    for (const resource of [
      "children",
      "bookings",
      "providers",
      "saved",
      "managed-activities",
    ]) {
      const response = await fetch(`${base}/v1/${resource}?pageSize=1`, {
        headers: headers("parent"),
      });
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.ok(Array.isArray(page.items));
      assert.ok(page.items.length <= 1);
      assert.equal(page.pageSize, 1);
    }
    for (const resource of [
      "audit",
      "refunds",
      "contacts",
      "campaigns",
      "subscriptions",
      "corrections",
    ]) {
      assert.equal(
        (
          await fetch(`${base}/v1/admin/lists/${resource}`, {
            headers: headers("parent"),
          })
        ).status,
        403,
      );
      const response = await fetch(
        `${base}/v1/admin/lists/${resource}?pageSize=1`,
        { headers: headers("admin") },
      );
      assert.equal(response.status, 200);
      assert.ok((await response.json()).items.length <= 1);
    }
    const scoped = await (
      await fetch(`${base}/v1/bookings?scope=parent`, {
        headers: headers("staff"),
      })
    ).json();
    assert.equal(scoped.total, 1);
    assert.equal(scoped.items[0].parent_id, actors.staff.id);
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    const anonymous = await fetch(`${base}/v1/bookings/${booking.id}`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await fetch(`${base}/v1/bookings/${booking.id}`, {
          headers: headers("other"),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/bookings/${booking.id}`, {
          headers: headers("staff"),
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/v1/activities/${hidden.id}`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/v1/activities?pageSize=101`)).status,
      422,
    );
    assert.equal(
      (await (await fetch(`${base}/v1/activities?age=&area=&category=`)).json())
        .total,
      3,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/children`, {
          method: "POST",
          headers: headers("parent"),
          body: JSON.stringify({
            firstName: "Synthetic",
            ageYears: 6,
            birthDate: "2020-01-01",
          }),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/children/${ageOnly.id}`, {
          method: "PUT",
          headers: headers("other"),
          body: JSON.stringify({ firstName: "Synthetic", ageYears: 6 }),
        })
      ).status,
      404,
    );
    const escalation = await fetch(
      `${base}/v1/providers/${organization.id}/members`,
      {
        method: "POST",
        headers: headers("staff"),
        body: JSON.stringify({
          userId: actors.other.id,
          role: "admin",
          active: true,
        }),
      },
    );
    assert.equal(escalation.status, 422);
    assert.equal(
      (
        await fetch(`${base}/v1/admin/operations`, {
          headers: headers("staff"),
        })
      ).status,
      403,
    );
    await assert.rejects(
      () => p.approve(actors.admin, organization.id, "suspended"),
      /reason/,
    );
    await p.approve(
      actors.admin,
      organization.id,
      "suspended",
      "Synthetic suspension test",
    );
    assert.equal(
      (
        await fetch(`${base}/v1/bookings/${booking.id}`, {
          headers: headers("staff"),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/bookings/${booking.id}`, {
          headers: headers("parent"),
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/v1/activities/${activity.id}`)).status,
      404,
    );
    assert.equal((await p.catalog()).length, 1);
    assert.equal((await p.catalog())[0].id, otherActivity.id);
    await pg.query("UPDATE app.profiles SET active=false WHERE id=$1", [
      actors.staff.id,
    ]);
    assert.equal(
      (await fetch(`${base}/v1/me`, { headers: headers("staff") })).status,
      403,
    );
    await p.setMember(actors.admin, organization.id, actors.staff.id, false);
    await assert.rejects(
      () => p.setMember(actors.admin, organization.id, actors.staff.id, true),
      /Active account/,
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pg.close();
  }
});

test("authentication separates invalid credentials, upstream failure and validated identity", async () => {
  const oldOrigin = process.env.SUPABASE_URL,
    oldKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const originalFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://auth.example.invalid/";
  process.env.SUPABASE_PUBLISHABLE_KEY = "synthetic-publishable-key";
  try {
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(
      () => authenticate("synthetic"),
      (error) => (error as { status: number }).status === 401,
    );
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    await assert.rejects(
      () => authenticate("synthetic"),
      (error) => (error as { status: number }).status === 503,
    );
    globalThis.fetch = async () => {
      throw new Error("Synthetic timeout");
    };
    await assert.rejects(
      () => authenticate("synthetic"),
      /temporarily unavailable/,
    );
    globalThis.fetch = async () =>
      Response.json({ id: "not-a-uuid", email: "bad" });
    await assert.rejects(() => authenticate("synthetic"), /invalid response/);
    const id = randomUUID();
    globalThis.fetch = async (input, options) => {
      assert.equal(input, "https://auth.example.invalid/auth/v1/user");
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        "Bearer synthetic",
      );
      return Response.json({
        id,
        email: "synthetic@example.invalid",
        user_metadata: { role: "admin" },
      });
    };
    assert.deepEqual(await authenticate("synthetic"), {
      id,
      email: "synthetic@example.invalid",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOrigin === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldOrigin;
    if (oldKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = oldKey;
  }
});

test("support isolation, pagination and reviewed content publication", async () => {
  const pg = new PGlite();
  try {
    const db = databaseFor(pg);
    await migrate(db);
    const p = new Platform(db);
    const parent = {id:randomUUID(),role:"parent"};
    const other = {id:randomUUID(),role:"parent"};
    const admin = {id:randomUUID(),role:"admin"};
    for(const a of [parent,other,admin]) await p.me(a.id,`${a.id}@example.invalid`);
    const ticket = await p.createSupport(parent,"Booking","Synthetic support message");
    await p.createSupport(parent,"Account","Another synthetic message");
    await p.createSupport(other,"Account","Private other account message");
    const first = await p.support(parent,{page:1,pageSize:1});
    const second = await p.support(parent,{page:2,pageSize:1});
    assert.equal(first.total,2);
    assert.equal(first.pages,2);
    assert.notEqual(first.items[0].id,second.items[0].id);
    assert.equal((await p.support(admin,{page:1,pageSize:20})).total,3);
    await assert.rejects(()=>p.replySupport(other,ticket.id,"resolved","Denied"),/Administrator/);
    await p.replySupport(admin,ticket.id,"resolved","Synthetic response");
    assert.equal((await p.support(parent,{page:1,pageSize:20},"resolved")).total,1);
    assert.equal((await p.support(other,{page:1,pageSize:20},"resolved")).total,0);
    const draft={title:"About",body:"Reviewed synthetic content",published:false,version:0};
    await assert.rejects(()=>p.saveContent(parent,"about",draft),/Administrator/);
    await p.saveContent(admin,"about",draft);
    assert.equal(await p.content("about"),null);
    assert.equal((await p.content("about",admin)).version,1);
    await assert.rejects(()=>p.saveContent(admin,"about",draft),/changed/);
    await p.saveContent(admin,"about",{...draft,published:true,version:1});
    assert.equal((await p.content("about")).version,2);
    await assert.rejects(()=>p.saveContent(admin,"about",{...draft,version:1}),/changed/);
    await p.saveContent(admin,"about",{...draft,version:2});
    assert.equal(await p.content("about"),null);
  } finally { await pg.close(); }
});
