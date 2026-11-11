import { randomUUID, createHash } from "node:crypto";
import { transaction, type Database, type Connection } from "./database.js";
import { ageOnDate, possibleAges, dubaiDate } from "./eligibility.js";
import type { Pagination } from "./pagination.js";
import { recordNotifications } from "./notifications.js";
import { migrationsReady } from "./migrations.js";
export interface Actor {
  id: string;
  role: string;
}
export interface CatalogFilters {
  q?: string;
  category?: string;
  area?: string;
  age?: number;
  limit?: number;
  offset?: number;
}
const bookingScope = `($2='admin' OR b.parent_id=$1 OR EXISTS(
  SELECT 1 FROM app.provider_memberships m JOIN app.providers p ON p.id=m.provider_id
  WHERE m.provider_id=b.provider_id AND m.user_id=$1 AND m.active AND p.status='approved'
))`;
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const uid = () => randomUUID();
export class Platform {
  constructor(
    readonly db: Database,
    readonly financeEnabled = false,
  ) {}
  async ready() {
    try {
      return await migrationsReady(this.db);
    } catch {
      return false;
    }
  }
  async support(a: Actor, paging: Pagination, status?: string) {
    return this.page("SELECT * FROM app.support WHERE ($1='admin' OR owner_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC,id", [a.role,a.id,status ?? null], paging);
  }
  async createSupport(a: Actor, topic: string, message: string) {
    return transaction(this.db, async c => {
      const id = uid();
      await c.query("INSERT INTO app.support(id,owner_id,topic,message) VALUES($1,$2,$3,$4)", [id,a.id,topic,message]);
      await this.audit(c,a,id,"support.created");
      return { id };
    });
  }
  async replySupport(a: Actor, id: string, status: string, reply: string) {
    if(a.role !== "admin") fail(403,"Administrator access required.");
    return transaction(this.db, async c => {
      const result = await c.query("UPDATE app.support SET status=$2,reply=$3,updated_at=now() WHERE id=$1 RETURNING id", [id,status,reply]);
      if(!result.rows.length) fail(404,"Support request not found.");
      await this.audit(c,a,id,"support.updated");
      return { id };
    });
  }
  async content(slug: string, a?: Actor) {
    const rows = await this.read("SELECT * FROM app.content WHERE slug=$1 AND ($2 OR published)", [slug,a?.role === "admin"]);
    return rows[0] ?? null;
  }
  async saveContent(a: Actor, slug: string, body: {title:string;body:string;published:boolean;version:number}) {
    if(a.role !== "admin") fail(403,"Administrator access required.");
    return transaction(this.db, async c => {
      const result = await c.query(`INSERT INTO app.content(slug,title,body,published) SELECT $1,$2,$3,$4 WHERE $5=0
        ON CONFLICT(slug) DO NOTHING RETURNING *`, [slug,body.title,body.body,body.published,body.version]);
      const rows = body.version === 0 ? result.rows : (await c.query("UPDATE app.content SET title=$2,body=$3,published=$4,version=version+1,updated_at=now() WHERE slug=$1 AND version=$5 RETURNING *", [slug,body.title,body.body,body.published,body.version])).rows;
      if(!rows.length) fail(409,"This page changed. Reload before editing again.");
      await this.audit(c,a,a.id,"content.updated",{slug});
      return rows[0];
    });
  }
  async read(sql: string, params: unknown[] = []) {
    const c = await this.db.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      c.release();
    }
  }
  async audit(
    c: Connection,
    a: Actor,
    subject: string,
    action: string,
    details: unknown = {},
  ) {
    const auditId = uid();
    await c.query(
      "INSERT INTO app.audit(id,actor_id,subject_id,action,details) VALUES($1,$2,$3,$4,$5)",
      [auditId, a.id, subject, action, JSON.stringify(details)],
    );
    await recordNotifications(c, auditId, subject, action);
  }
  async page(sql: string, params: unknown[], paging: Pagination) {
    const n = params.length;
    const row = (
      await this.read(
        `WITH filtered AS NOT MATERIALIZED (${sql}) SELECT
      (SELECT count(*)::int FROM filtered) AS total,
      COALESCE((SELECT json_agg(t) FROM (SELECT * FROM filtered LIMIT $${n + 1} OFFSET $${n + 2}) t),'[]') AS items`,
        [...params, paging.pageSize, (paging.page - 1) * paging.pageSize],
      )
    )[0];
    return {
      items: row.items,
      total: row.total,
      page: paging.page,
      pageSize: paging.pageSize,
      pages: Math.ceil(row.total / paging.pageSize),
    };
  }
  async list(
    resource: string,
    a: Actor,
    paging: Pagination,
    filters: CatalogFilters & {
      scope?: string;
      providerId?: string;
      activityId?: string;
      status?: string;
      owned?: boolean;
      state?: string;
    } = {},
  ) {
    if (resource === "sessions") {
      await this.activity(filters.activityId!);
      return this.page(
        "SELECT id,starts_at,cutoff_at,capacity,allocated FROM app.sessions WHERE activity_id=$1 AND cutoff_at>now() ORDER BY starts_at,id",
        [filters.activityId],
        paging,
      );
    }
    if (resource === "activities")
      return this.page(
        `SELECT a.*,p.name AS provider_name,EXISTS(SELECT 1 FROM app.saved_activities saved WHERE saved.activity_id=a.id AND saved.user_id=$5::uuid) AS is_saved FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
      WHERE a.published AND p.status='approved'
      AND ($1::text IS NULL OR strpos(lower(a.title||' '||a.description||' '||a.category||' '||a.area),lower($1))>0)
      AND ($2::text IS NULL OR lower(a.category)=lower($2)) AND ($3::text IS NULL OR lower(a.area)=lower($3))
      AND ($4::int IS NULL OR $4 BETWEEN a.min_age AND a.max_age) ORDER BY a.title,a.id`,
        [
          filters.q ?? null,
          filters.category ?? null,
          filters.area ?? null,
          filters.age ?? null,
          a.role === "public" ? null : a.id,
        ],
        paging,
      );
    if (resource === "children")
      return this.page(
        "SELECT id,first_name,surname,birth_date,age_years,age_recorded_on FROM app.children WHERE parent_id=$1 ORDER BY first_name,id",
        [a.id],
        paging,
      );
    if (resource === "bookings")
      return this.page(
        `SELECT b.* FROM app.bookings b WHERE ${bookingScope}
      AND ($3='all' OR ($3='parent' AND b.parent_id=$1) OR ($3='partner' AND EXISTS(SELECT 1 FROM app.provider_memberships m JOIN app.providers p ON p.id=m.provider_id WHERE m.provider_id=b.provider_id AND m.user_id=$1 AND m.active AND p.status='approved')))
      AND ($4::text IS NULL OR b.state=$4)
      ORDER BY b.created_at DESC,b.id`,
        [a.id, a.role, filters.scope ?? "all", filters.state ?? null],
        paging,
      );
    if (resource === "providers")
      return this.page(
        `SELECT p.* FROM app.providers p WHERE (p.owner_id=$1 OR $2='admin' OR
      (p.status='approved' AND EXISTS(SELECT 1 FROM app.provider_memberships m WHERE m.provider_id=p.id AND m.user_id=$1 AND m.active)))
      AND ($3::text IS NULL OR p.status=$3) AND (NOT $4::boolean OR p.owner_id=$1)
      ORDER BY p.created_at DESC,p.id`,
        [a.id, a.role, filters.status ?? null, filters.owned ?? false],
        paging,
      );
    if (resource === "saved")
      return this.page(
        `SELECT a.*,p.name AS provider_name FROM app.saved_activities x JOIN app.activities a ON a.id=x.activity_id
      JOIN app.providers p ON p.id=a.provider_id WHERE x.user_id=$1 AND a.published AND p.status='approved' ORDER BY x.created_at DESC,a.id`,
        [a.id],
        paging,
      );
    if (resource === "managed-activities")
      return this.page(
        `SELECT a.*,p.name AS provider_name FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
      WHERE $2='admin' OR (p.status='approved' AND EXISTS(SELECT 1 FROM app.provider_memberships m WHERE m.provider_id=p.id AND m.user_id=$1 AND m.active)) ORDER BY a.title,a.id`,
        [a.id, a.role],
        paging,
      );
    if (resource === "members") {
      await transaction(this.db, (c) =>
        this.requireTeamOwner(c, a, filters.providerId!),
      );
      return this.page(
        `SELECT m.user_id,m.role,m.active,p.email FROM app.provider_memberships m JOIN app.profiles p ON p.id=m.user_id
        WHERE m.provider_id=$1 AND ($2='admin' OR EXISTS(SELECT 1 FROM app.providers o JOIN app.provider_memberships own ON own.provider_id=o.id
          WHERE o.id=m.provider_id AND o.owner_id=$3 AND o.status='approved' AND own.user_id=$3 AND own.role='owner' AND own.active))
        ORDER BY m.role,p.email,m.user_id`,
        [filters.providerId, a.role, a.id],
        paging,
      );
    }
    this.admin(a);
    const adminLists: Record<string, string> = {
      audit: "SELECT * FROM app.audit ORDER BY created_at DESC,id",
      refunds: "SELECT * FROM app.refunds ORDER BY status,id",
      contacts:
        "SELECT id,name,right(phone,4) AS phone_suffix,marketing,suppressed FROM app.contacts ORDER BY created_at DESC,id",
      campaigns: "SELECT * FROM app.campaigns ORDER BY created_at DESC,id",
      subscriptions:
        "SELECT s.*,p.name FROM app.subscriptions s JOIN app.providers p ON p.id=s.provider_id ORDER BY s.expires_at,s.provider_id",
      corrections:
        "SELECT c.*,a.title,p.name AS provider_name FROM app.corrections c JOIN app.activities a ON a.id=c.activity_id JOIN app.providers p ON p.id=c.provider_id ORDER BY c.id",
    };
    if (!adminLists[resource]) fail(404, "List not found.");
    return this.page(adminLists[resource], [], paging);
  }
  admin(a: Actor) {
    if (a.role !== "admin") fail(403, "Admin access required.");
  }
  async me(id: string, email: string) {
    return transaction(this.db, async (c) => {
      await c.query(
        "INSERT INTO app.profiles(id,email) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email",
        [id, email],
      );
      const p = (
        await c.query(
          "SELECT id,email,role,active FROM app.profiles WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!p.active) fail(403, "Account is disabled.");
      const hasPartner = (
        await c.query(
          `SELECT EXISTS(SELECT 1 FROM app.provider_memberships m JOIN app.providers p ON p.id=m.provider_id
        WHERE m.user_id=$1 AND m.active AND p.status='approved') AS allowed`,
          [id],
        )
      ).rows[0].allowed;
      const roles = ["parent"];
      if (hasPartner) roles.push("partner");
      if (p.role === "admin") roles.push("superadmin");
      return { ...p, id: p.id as string, role: p.role as string, email: p.email as string, roles };
    });
  }
  catalog(filters: CatalogFilters = {}) {
    return this.read(
      `SELECT a.*,p.name AS provider_name
       FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
       WHERE a.published AND p.status='approved'
       AND ($1::text IS NULL OR strpos(lower(a.title || ' ' || a.description || ' ' || a.category || ' ' || a.area),lower($1))>0)
       AND ($2::text IS NULL OR lower(a.category)=lower($2))
       AND ($3::text IS NULL OR lower(a.area)=lower($3))
       AND ($4::int IS NULL OR $4 BETWEEN a.min_age AND a.max_age)
       ORDER BY a.title,a.id LIMIT $5 OFFSET $6`,
      [
        filters.q ?? null,
        filters.category ?? null,
        filters.area ?? null,
        filters.age ?? null,
        filters.limit ?? 100,
        filters.offset ?? 0,
      ],
    );
  }
  async activity(id: string, actor?: Actor) {
    const result = await this.read(
      `SELECT a.*,p.name AS provider_name,EXISTS(SELECT 1 FROM app.saved_activities saved WHERE saved.activity_id=a.id AND saved.user_id=$2::uuid) AS is_saved
       FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
       WHERE a.id=$1 AND a.published AND p.status='approved'`,
      [id,actor?.role === "public" ? null : actor?.id ?? null],
    );
    if (!result.length) fail(404, "Activity not found.");
    return result[0];
  }
  saved(a: Actor) {
    return this.read(
      `SELECT a.*,p.name AS provider_name FROM app.saved_activities x
      JOIN app.activities a ON a.id=x.activity_id JOIN app.providers p ON p.id=a.provider_id
      WHERE x.user_id=$1 AND a.published AND p.status='approved' ORDER BY x.created_at DESC LIMIT 200`,
      [a.id],
    );
  }
  async save(a: Actor, id: string, saved: boolean) {
    return transaction(this.db, async (c) => {
      if (saved) {
        const visible = (
          await c.query(
            `SELECT a.id FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
          WHERE a.id=$1 AND a.published AND p.status='approved'`,
            [id],
          )
        ).rows[0];
        if (!visible) fail(404, "Activity not found.");
        await c.query(
          "INSERT INTO app.saved_activities(user_id,activity_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [a.id, id],
        );
      } else
        await c.query(
          "DELETE FROM app.saved_activities WHERE user_id=$1 AND activity_id=$2",
          [a.id, id],
        );
      return { id, saved };
    });
  }
  managedActivities(a: Actor) {
    return this.read(
      `SELECT a.*,p.name AS provider_name,COALESCE((SELECT json_agg(s ORDER BY starts_at) FROM app.sessions s WHERE s.activity_id=a.id),'[]') AS sessions
      FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
      WHERE $2='admin' OR (p.status='approved' AND EXISTS(SELECT 1 FROM app.provider_memberships m
        WHERE m.provider_id=p.id AND m.user_id=$1 AND m.active)) ORDER BY a.title,a.id LIMIT 200`,
      [a.id, a.role],
    );
  }
  async publishActivity(a: Actor, id: string, published: boolean) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const result = (
        await c.query(
          `UPDATE app.activities SET published=$2,version=version+1 WHERE id=$1
        AND (NOT $2 OR EXISTS(SELECT 1 FROM app.providers p WHERE p.id=provider_id AND p.status='approved')) RETURNING id,published`,
          [id, published],
        )
      ).rows[0];
      if (!result)
        fail(409, "Activity is missing or its provider is not approved.");
      await this.audit(
        c,
        a,
        id,
        published ? "activity.published" : "activity.unpublished",
      );
      return result;
    });
  }
  async updateActivity(a: Actor, id: string, b: Record<string, any>) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const result = (
        await c.query(
          `UPDATE app.activities SET title=$2,description=$3,category=$4,area=$5,min_age=$6,max_age=$7,price_fils=$8,policy=$9,version=version+1 WHERE id=$1 RETURNING id,version`,
          [
            id,
            b.title,
            b.description,
            b.category,
            b.area,
            b.minAge,
            b.maxAge,
            b.priceFils,
            b.policy,
          ],
        )
      ).rows[0];
      if (!result) fail(404, "Activity not found.");
      await this.audit(c, a, id, "activity.updated");
      return result;
    });
  }
  async addSession(
    a: Actor,
    id: string,
    b: { startsAt: string; cutoffAt: string; capacity: number },
  ) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const activity = (
        await c.query("SELECT id FROM app.activities WHERE id=$1", [id])
      ).rows[0];
      if (!activity) fail(404, "Activity not found.");
      const sessionId = uid();
      await c.query(
        "INSERT INTO app.sessions(id,activity_id,starts_at,cutoff_at,capacity) VALUES($1,$2,$3,$4,$5)",
        [sessionId, id, b.startsAt, b.cutoffAt, b.capacity],
      );
      await this.audit(c, a, id, "session.created", { sessionId });
      return { id: sessionId };
    });
  }
  async reviewCorrection(a: Actor, id: string, status: string, reason: string) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const result = (
        await c.query(
          "UPDATE app.corrections SET status=$2 WHERE id=$1 AND status='pending' RETURNING id",
          [id, status],
        )
      ).rows[0];
      if (!result) fail(409, "Correction is missing or already reviewed.");
      await this.audit(c, a, id, "correction." + status, { reason });
      return result;
    });
  }
  children(a: Actor) {
    return this.read(
      "SELECT id,first_name,surname,birth_date,age_years,age_recorded_on FROM app.children WHERE parent_id=$1 ORDER BY first_name",
      [a.id],
    );
  }
  async addChild(
    a: Actor,
    b: {
      firstName: string;
      surname?: string;
      birthDate?: string;
      ageYears?: number;
    },
  ) {
    if ((b.birthDate !== undefined) === (b.ageYears !== undefined))
      fail(422, "Provide either an age or a birth date.");
    return transaction(this.db, async (c) => {
      const id = uid();
      await c.query(
        "INSERT INTO app.children(id,parent_id,first_name,surname,birth_date,age_years,age_recorded_on) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          a.id,
          b.firstName,
          b.surname ?? "",
          b.birthDate ?? null,
          b.ageYears ?? null,
          b.ageYears === undefined ? null : dubaiDate(),
        ],
      );
      await this.audit(c, a, id, "child.created");
      return { id };
    });
  }
  async updateChild(
    a: Actor,
    id: string,
    b: {
      firstName: string;
      surname?: string;
      birthDate?: string;
      ageYears?: number;
    },
  ) {
    if ((b.birthDate !== undefined) === (b.ageYears !== undefined))
      fail(422, "Provide either an age or a birth date.");
    return transaction(this.db, async (c) => {
      const updated = (
        await c.query(
          `UPDATE app.children SET first_name=$3,surname=$4,birth_date=$5,age_years=$6,age_recorded_on=$7
         WHERE id=$1 AND parent_id=$2 RETURNING id`,
          [
            id,
            a.id,
            b.firstName,
            b.surname ?? "",
            b.birthDate ?? null,
            b.ageYears ?? null,
            b.ageYears === undefined ? null : dubaiDate(),
          ],
        )
      ).rows[0];
      if (!updated) fail(404, "Child not found.");
      await this.audit(c, a, id, "child.updated");
      return updated;
    });
  }
  bookings(a: Actor, id?: string) {
    return this.read(
      `SELECT b.*,COALESCE((SELECT json_agg(json_build_object('id',x.id,'first_name',x.first_name,'surname',x.surname)) FROM app.participants j JOIN app.children x ON x.id=j.child_id WHERE j.booking_id=b.id),'[]') AS children,(SELECT json_agg(p) FROM app.payments p WHERE p.booking_id=b.id) AS payments,(SELECT json_agg(r) FROM app.refunds r WHERE r.booking_id=b.id) AS refunds
       FROM app.bookings b WHERE ${bookingScope} AND ($3::uuid IS NULL OR b.id=$3) ORDER BY b.created_at DESC,b.id LIMIT 200`,
      [a.id, a.role, id ?? null],
    );
  }
  async booking(a: Actor, id: string) {
    const result = await this.bookings(a, id);
    if (!result.length) fail(404, "Booking not found.");
    return result[0];
  }
  async command<T>(
    a: Actor,
    key: string,
    body: unknown,
    fn: (c: Connection) => Promise<T>,
    authorize?: (c: Connection) => Promise<void>,
  ): Promise<T> {
    return transaction(this.db, async (c) => {
      // Recheck resource access even when returning a previously successful command.
      if (authorize) await authorize(c);
      const hash = createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");
      await c.query(
        "INSERT INTO app.idempotency(actor_id,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [a.id, key, hash],
      );
      const old = (
        await c.query(
          "SELECT * FROM app.idempotency WHERE actor_id=$1 AND key=$2 FOR UPDATE",
          [a.id, key],
        )
      ).rows[0];
      if (old.fingerprint !== hash)
        fail(409, "Idempotency key was used for a different request.");
      if (old.response) return old.response;
      const response = await fn(c);
      await c.query(
        "UPDATE app.idempotency SET response=$3 WHERE actor_id=$1 AND key=$2",
        [a.id, key, JSON.stringify(response)],
      );
      return response;
    });
  }
  async request(
    a: Actor,
    key: string,
    b: { sessionId: string; activityVersion: number; childIds: string[]; policyAccepted: boolean },
  ) {
    if (!b.policyAccepted) fail(422, "Accept the cancellation policy.");
    return this.command(a, key, { op: "request", ...b }, async (c) => {
      const s = (
        await c.query(
          `SELECT s.*,a.version AS listing_version,a.title,a.price_fils,a.policy,a.provider_id,a.min_age,a.max_age,p.name AS provider_name FROM app.sessions s JOIN app.activities a ON a.id=s.activity_id JOIN app.providers p ON p.id=a.provider_id WHERE s.id=$1 AND a.published AND p.status='approved' FOR SHARE OF a,p`,
          [b.sessionId],
        )
      ).rows[0];
      if (!s || new Date(s.cutoff_at) <= new Date())
        fail(409, "This session is no longer accepting requests.");
      if (b.activityVersion !== s.listing_version)
        fail(409, "The activity price or terms changed. Review the current listing.");
      const kids = (
        await c.query(
          "SELECT * FROM app.children WHERE parent_id=$1 AND NOT archived AND id=ANY($2::uuid[])",
          [a.id, b.childIds],
        )
      ).rows;
      if (kids.length !== b.childIds.length)
        fail(422, "Select children from your own account.");
      for (const k of kids) {
        const start = new Date(dubaiDate(new Date(s.starts_at)));
        if (k.birth_date) {
          const age = ageOnDate(new Date(k.birth_date), start);
          if (age < s.min_age || age > s.max_age)
            fail(422, "A selected child is outside the activity age range.");
        } else {
          const [youngest, oldest] = possibleAges(
            k.age_years,
            new Date(k.age_recorded_on),
            start,
          );
          if (oldest < s.min_age || youngest > s.max_age)
            fail(422, "A selected child is outside the activity age range.");
          if (youngest < s.min_age || oldest > s.max_age)
            fail(
              422,
              "An exact birth date is required to check this activity's age limits.",
            );
        }
      }
      const id = uid(),
        due = new Date(
          Math.min(Date.now() + 86400000, new Date(s.cutoff_at).getTime()),
        );
      const snapshot = {
        listingVersion: s.listing_version,
        title: s.title,
        provider: s.provider_name,
        startsAt: s.starts_at,
        policy: s.policy,
        children: kids.map((k) => ({
          id: k.id,
          firstName: k.first_name,
          surname: k.surname,
        })),
        unitPriceFils: s.price_fils,
        currency: "AED",
      };
      await c.query(
        `INSERT INTO app.bookings(id,parent_id,provider_id,session_id,state,quantity,amount_fils,snapshot,response_due_at) VALUES($1,$2,$3,$4,'REQUESTED',$5,$6,$7,$8)`,
        [
          id,
          a.id,
          s.provider_id,
          b.sessionId,
          kids.length,
          kids.length * s.price_fils,
          JSON.stringify(snapshot),
          due,
        ],
      );
      for (const child of kids)
        await c.query(
          "INSERT INTO app.participants(booking_id,child_id,session_id) VALUES($1,$2,$3)",
          [id, child.id, b.sessionId],
        );
      await this.audit(c, a, id, "request.submitted");
      await c.query(
        "INSERT INTO app.outbox(id,booking_id,event) VALUES($1,$2,$3)",
        [uid(), id, "request.submitted"],
      );
      return { id };
    });
  }
  async act(
    a: Actor,
    key: string,
    id: string,
    b: {
      action: string;
      version: number;
      reason?: string;
      amountFils?: number;
      reference?: string;
    },
  ) {
    return this.command(
      a,
      key,
      { id, ...b },
      async (c) => {
        const booking = (
          await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0];
        if (!booking) fail(404, "Booking not found.");
        const owner = (
          await c.query(
            `SELECT p.owner_id,p.status,m.role AS membership_role FROM app.providers p
          LEFT JOIN app.provider_memberships m ON m.provider_id=p.id AND m.user_id=$2 AND m.active
          WHERE p.id=$1`,
            [booking.provider_id, a.id],
          )
        ).rows[0];
        const parent = booking.parent_id === a.id,
          provider =
            Boolean(owner?.membership_role) && owner.status === "approved",
          admin = a.role === "admin";
        if (!parent && !provider && !admin) fail(404, "Booking not found.");
        if (b.version !== booking.version)
          fail(409, "This booking changed. Refresh before continuing.");
        let state = booking.state,
          held = booking.held,
          due = booking.payment_due_at,
          offer = booking.offer,
          amount = booking.amount_fils;
        const session = (
          await c.query("SELECT * FROM app.sessions WHERE id=$1 FOR UPDATE", [
            booking.session_id,
          ])
        ).rows[0];
        const now = new Date();
        const cutoff = new Date(session.cutoff_at);
        const hold = async () => {
          if (owner.status !== 'approved') fail(409,"Provider is not currently accepting bookings.");
          if (cutoff <= now) fail(409, "Booking cutoff has passed.");
          if (session.allocated + booking.quantity > session.capacity)
            fail(409, "Not enough places remain.");
          await c.query(
            "UPDATE app.sessions SET allocated=allocated+$2 WHERE id=$1",
            [session.id, booking.quantity],
          );
          held = true;
          due = new Date(Math.min(Date.now() + 86400000, cutoff.getTime()));
        };
        if (b.action === "accept") {
          if (!provider && !admin) fail(403, "Provider access required.");
          if (state !== "REQUESTED" || new Date(booking.response_due_at) < now)
            fail(409, "Request is no longer actionable.");
          await hold();
          state = "PAYMENT_DUE";
        } else if (b.action === "offer") {
          if (!provider && !admin) fail(403, "Provider access required.");
          if (state !== "REQUESTED" || new Date(booking.response_due_at) < now)
            fail(409, "Request is no longer actionable.");
          if (!b.amountFils) fail(422, "Enter an offer total.");
          offer = {
            amountFils: b.amountFils,
            reason: b.reason,
            version: booking.version + 1,
            expiresAt: session.cutoff_at,
          };
          state = "OFFER_PENDING";
        } else if (b.action === "accept-offer") {
          if (!parent) fail(403, "Parent approval required.");
          if (state !== "OFFER_PENDING" || !offer)
            fail(409, "No current offer.");
          amount = offer.amountFils;
          await hold();
          state = "PAYMENT_DUE";
        } else if (b.action === "decline") {
          if (!provider && !admin) fail(403, "Provider access required.");
          if (!["REQUESTED", "OFFER_PENDING"].includes(state))
            fail(409, "Request cannot be declined.");
          state = "DECLINED";
        } else if (b.action === "proof") {
          if (!parent) fail(403, "Parent access required.");
          if (!this.financeEnabled)
            fail(
              409,
              "Payment collection and verification ownership must be configured first.",
            );
          if (state !== "PAYMENT_DUE" || new Date(due) < now)
            fail(409, "Payment window is closed.");
          if (!b.reference) fail(422, "Payment reference is required.");
          await c.query(
            "INSERT INTO app.payments(id,booking_id,amount_fils,reference,status) VALUES($1,$2,$3,$4,'submitted')",
            [uid(), id, amount, b.reference],
          );
          state = "PAYMENT_CHECKING";
        } else if (b.action === "verify") {
          this.admin(a);
          if (!this.financeEnabled)
            fail(
              409,
              "Finance workflow is disabled until ownership is agreed.",
            );
          if (state !== "PAYMENT_CHECKING")
            fail(409, "No payment is awaiting review.");
          await c.query(
            "UPDATE app.payments SET status='verified',verified_by=$2 WHERE booking_id=$1",
            [id, a.id],
          );
          state = "CONFIRMED";
        } else if (b.action === "cancel") {
          if (!b.reason) fail(422, "A cancellation reason is required.");
          if (["CANCELLED", "EXPIRED", "DECLINED"].includes(state))
            fail(409, "Booking has already ended.");
          if (
            parent &&
            !provider &&
            !admin &&
            ["CONFIRMED", "PAYMENT_CHECKING"].includes(state)
          )
            fail(
              409,
              "Contact support to apply the accepted cancellation policy.",
            );
          const paid = (
            await c.query(
              "SELECT * FROM app.payments WHERE booking_id=$1 AND status='verified'",
              [id],
            )
          ).rows[0];
          if (paid)
            await c.query(
              "INSERT INTO app.refunds(id,booking_id,amount_fils) VALUES($1,$2,$3)",
              [uid(), id, paid.amount_fils],
            );
          state = "CANCELLED";
        } else fail(422, "Unsupported action.");
        if (["CANCELLED", "DECLINED"].includes(state)) {
          if (held)
            await c.query(
              "UPDATE app.sessions SET allocated=allocated-$2 WHERE id=$1",
              [session.id, booking.quantity],
            );
          held = false;
          await c.query(
            "UPDATE app.participants SET active=false WHERE booking_id=$1",
            [id],
          );
        }
        await c.query(
          "UPDATE app.bookings SET state=$2,held=$3,payment_due_at=$4,offer=$5,amount_fils=$6,version=version+1 WHERE id=$1",
          [id, state, held, due, offer ? JSON.stringify(offer) : null, amount],
        );
        await this.audit(c, a, id, b.action, {
          reason: b.reason,
          previous: booking.state,
          state,
        });
        await c.query(
          "INSERT INTO app.outbox(id,booking_id,event) VALUES($1,$2,$3)",
          [uid(), id, state],
        );
        return { id, state };
      },
      async (c) => {
        const allowed = (
          await c.query(
            `SELECT b.parent_id,EXISTS(
        SELECT 1 FROM app.provider_memberships m JOIN app.providers p ON p.id=m.provider_id
        WHERE m.provider_id=b.provider_id AND m.user_id=$1 AND m.active AND p.status='approved'
      ) AS partner_access FROM app.bookings b WHERE b.id=$3 AND ${bookingScope}`,
            [a.id, a.role, id],
          )
        ).rows[0];
        if (!allowed) fail(404, "Booking not found.");
        if (
          ["accept", "offer", "decline"].includes(b.action) &&
          a.role !== "admin" &&
          !allowed.partner_access
        )
          fail(403, "Provider access required.");
        if (b.action === "verify") this.admin(a);
        if (
          ["accept-offer", "proof"].includes(b.action) &&
          allowed.parent_id !== a.id
        )
          fail(403, "Parent access required.");
      },
    );
  }
  providers(a: Actor) {
    return this.read(
      `SELECT p.* FROM app.providers p WHERE p.owner_id=$1 OR $2='admin' OR (p.status='approved' AND EXISTS(
        SELECT 1 FROM app.provider_memberships m WHERE m.provider_id=p.id AND m.user_id=$1 AND m.active
      )) ORDER BY p.created_at DESC`,
      [a.id, a.role],
    );
  }
  private async requireTeamOwner(c: Connection, a: Actor, providerId: string) {
    const provider = (
      await c.query(
        `SELECT p.owner_id,p.status,m.role,m.active FROM app.providers p
       LEFT JOIN app.provider_memberships m ON m.provider_id=p.id AND m.user_id=$2
       WHERE p.id=$1 FOR UPDATE OF p`,
        [providerId, a.id],
      )
    ).rows[0];
    if (
      !provider ||
      (a.role !== "admin" &&
        !(
          provider.owner_id === a.id &&
          provider.role === "owner" &&
          provider.active &&
          provider.status === "approved"
        ))
    ) {
      fail(404, "Provider not found.");
    }
  }
  async members(a: Actor, providerId: string) {
    return transaction(this.db, async (c) => {
      await this.requireTeamOwner(c, a, providerId);
      return (
        await c.query(
          `SELECT m.user_id,m.role,m.active,p.email FROM app.provider_memberships m
         JOIN app.profiles p ON p.id=m.user_id WHERE m.provider_id=$1 ORDER BY m.role,p.email,m.user_id`,
          [providerId],
        )
      ).rows;
    });
  }
  async setMember(
    a: Actor,
    providerId: string,
    userId: string,
    active: boolean,
  ) {
    return transaction(this.db, async (c) => {
      await this.requireTeamOwner(c, a, providerId);
      const provider = (
        await c.query("SELECT owner_id FROM app.providers WHERE id=$1", [
          providerId,
        ])
      ).rows[0];
      if (provider.owner_id === userId)
        fail(409, "The provider owner cannot be changed through staff access.");
      const user = (
        await c.query("SELECT id,active FROM app.profiles WHERE id=$1", [
          userId,
        ])
      ).rows[0];
      if (!user || (active && !user.active))
        fail(404, "Active account not found.");
      await c.query(
        `INSERT INTO app.provider_memberships(provider_id,user_id,role,active) VALUES($1,$2,'staff',$3)
         ON CONFLICT(provider_id,user_id) DO UPDATE SET active=excluded.active`,
        [providerId, userId, active],
      );
      await this.audit(
        c,
        a,
        providerId,
        active ? "member.activated" : "member.suspended",
        { userId, role: "staff" },
      );
      return { providerId, userId, role: "staff", active };
    });
  }
  async apply(a: Actor, b: { name: string; description: string }) {
    return transaction(this.db, async (c) => {
      const id = uid();
      await c.query(
        "INSERT INTO app.providers(id,owner_id,name,description) VALUES($1,$2,$3,$4)",
        [id, a.id, b.name, b.description],
      );
      await this.audit(c, a, id, "provider.applied");
      await c.query(
        "INSERT INTO app.provider_memberships(provider_id,user_id,role) VALUES($1,$2,'owner')",
        [id, a.id],
      );
      return { id };
    });
  }
  async approve(a: Actor, id: string, status: string, reason?: string) {
    this.admin(a);
    if (status !== "approved" && !reason?.trim())
      fail(422, "A review reason is required.");
    return transaction(this.db, async (c) => {
      const p = (
        await c.query(
          "UPDATE app.providers SET status=$2 WHERE id=$1 RETURNING id",
          [id, status],
        )
      ).rows[0];
      if (!p) fail(404, "Provider not found.");
      if (status === "approved")
        await c.query(
          "UPDATE app.profiles SET role='provider' WHERE id=(SELECT owner_id FROM app.providers WHERE id=$1) AND role='parent'",
          [id],
        );
      await this.audit(c, a, id, "provider." + status, { reason });
      return p;
    });
  }
  async createActivity(a: Actor, b: Record<string, any>) {
    return transaction(this.db, async (c) => {
      if (b.published) {
        const provider = (await c.query("SELECT status FROM app.providers WHERE id=$1 FOR SHARE", [b.providerId])).rows[0];
        if (provider?.status !== 'approved') fail(409,"Only approved providers may have published activities.");
      }
      if (a.role !== "admin") {
        const member = (
          await c.query(
            `SELECT m.provider_id FROM app.provider_memberships m JOIN app.providers p ON p.id=m.provider_id
          WHERE m.provider_id=$1 AND m.user_id=$2 AND m.active AND p.status='approved' FOR UPDATE OF p`,
            [b.providerId, a.id],
          )
        ).rows[0];
        if (!member) fail(403, "Approved partner access required.");
        if (b.published) fail(403, "Only a Superadmin may publish activities.");
      }
      const id = uid(),
        sessionId = uid();
      await c.query(
        "INSERT INTO app.activities(id,provider_id,title,description,category,area,min_age,max_age,price_fils,policy,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          b.providerId,
          b.title,
          b.description,
          b.category,
          b.area,
          b.minAge,
          b.maxAge,
          b.priceFils,
          b.policy,
          b.published,
        ],
      );
      await c.query(
        "INSERT INTO app.sessions(id,activity_id,starts_at,cutoff_at,capacity) VALUES($1,$2,$3,$4,$5)",
        [sessionId, id, b.startsAt, b.cutoffAt, b.capacity],
      );
      await this.audit(c, a, id, "activity.created");
      return { id, sessionId };
    });
  }
  async operations(a: Actor) {
    this.admin(a);
    return {
      counts: (
        await this
          .read(`SELECT (SELECT count(*)::int FROM app.providers WHERE status='pending') AS pending_providers,
        (SELECT count(*)::int FROM app.activities WHERE NOT published) AS draft_activities,
        (SELECT count(*)::int FROM app.bookings WHERE state='REQUESTED') AS open_requests,
        (SELECT count(*)::int FROM app.refunds WHERE status='pending') AS pending_refunds`)
      )[0],
      financeEnabled: this.financeEnabled,
      whatsappEnabled: false,
    };
  }
  async importContacts(
    a: Actor,
    rows: { phone: string; name: string }[],
    source: string,
    commit: boolean,
  ) {
    this.admin(a);
    const valid = rows.filter((r) => /^\+[1-9]\d{7,14}$/.test(r.phone));
    const unique = [...new Map(valid.map((r) => [r.phone, r])).values()];
    if (commit)
      await transaction(this.db, async (c) => {
        for (const r of unique)
          await c.query(
            "INSERT INTO app.contacts(id,phone,name,source) VALUES($1,$2,$3,$4) ON CONFLICT(phone) DO NOTHING",
            [uid(), r.phone, r.name, source],
          );
        await this.audit(c, a, a.id, "contacts.imported", {
          count: unique.length,
          source,
        });
      });
    return {
      total: rows.length,
      invalid: rows.length - valid.length,
      duplicates: valid.length - unique.length,
      valid: unique.length,
      sendingEligible: 0,
      committed: commit,
    };
  }
  async suppress(a: Actor, id: string) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const rows = (
        await c.query(
          "UPDATE app.contacts SET suppressed=true,marketing='revoked',updates='revoked' WHERE id=$1 RETURNING id",
          [id],
        )
      ).rows;
      if (!rows.length) fail(404, "Contact not found.");
      await this.audit(c, a, id, "contact.suppressed");
      return rows[0];
    });
  }
  async campaign(
    a: Actor,
    b: { name: string; template: string; language: string },
  ) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const id = uid();
      await c.query(
        "INSERT INTO app.campaigns(id,name,template,language,created_by) VALUES($1,$2,$3,$4,$5)",
        [id, b.name, b.template, b.language, a.id],
      );
      await this.audit(c, a, id, "campaign.drafted");
      return { id, status: "draft" };
    });
  }
  async completeRefund(a: Actor, id: string, reference: string) {
    this.admin(a);
    if (!this.financeEnabled) fail(409, "Finance workflow is disabled.");
    return transaction(this.db, async (c) => {
      const refund = (
        await c.query("SELECT * FROM app.refunds WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!refund) fail(404, "Refund not found.");
      if (refund.status === "completed") return { id, status: "completed" };
      await c.query(
        "UPDATE app.refunds SET status='completed',evidence=$2,completed_by=$3 WHERE id=$1",
        [id, reference, a.id],
      );
      await this.audit(c, a, id, "refund.completed", { reference });
      return { id, status: "completed" };
    });
  }
  async correction(a: Actor, activityId: string, message: string) {
    return transaction(this.db, async (c) => {
      const activity = (
        await c.query(
          `SELECT a.provider_id FROM app.activities a JOIN app.providers p ON p.id=a.provider_id
           JOIN app.provider_memberships m ON m.provider_id=p.id
           WHERE a.id=$1 AND m.user_id=$2 AND m.active AND p.status='approved'`,
          [activityId, a.id],
        )
      ).rows[0];
      if (!activity) fail(404, "Activity not found.");
      const id = uid();
      await c.query(
        "INSERT INTO app.corrections(id,provider_id,activity_id,message) VALUES($1,$2,$3,$4)",
        [id, activity.provider_id, activityId, message],
      );
      await this.audit(c, a, id, "correction.requested");
      return { id };
    });
  }
  async expire(batchSize = 100) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      fail(422, "Expiry batch size must be between 1 and 100.");
    return transaction(this.db, async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM app.bookings WHERE state='PAYMENT_DUE' AND payment_due_at<now() ORDER BY payment_due_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",
          [batchSize],
        )
      ).rows;
      for (const b of rows) {
        await c.query(
          "UPDATE app.sessions SET allocated=allocated-$2 WHERE id=$1",
          [b.session_id, b.held ? b.quantity : 0],
        );
        await c.query(
          "UPDATE app.bookings SET state='EXPIRED',held=false,version=version+1 WHERE id=$1",
          [b.id],
        );
        await c.query(
          "UPDATE app.participants SET active=false WHERE booking_id=$1",
          [b.id],
        );
        await c.query(
          "INSERT INTO app.outbox(id,booking_id,event) VALUES($1,$2,$3)",
          [uid(), b.id, "EXPIRED"],
        );
        const auditId = uid();
        await c.query("INSERT INTO app.audit(id,subject_id,action) VALUES($1,$2,'booking.expired')", [auditId,b.id]);
        await recordNotifications(c,auditId,b.id,"booking.expired");
      }
      return rows.length;
    });
  }
}
