import {
  readBookingCursor,
  nextBookingCursor,
  type BookingPageQuery,
} from "./booking-pages.js";
import { recordNotifications } from "./notifications.js";
import { readMigrations } from "./migrations.js";
import { ageAtSession } from "./age.js";
import { randomUUID, createHash } from "node:crypto";
import { transaction, type Database, type Connection } from "./database.js";
export interface Actor {
  id: string;
  role: string;
}
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
    const migrations = await readMigrations();
    const rows = await this.read(
      "SELECT name,checksum FROM app.migrations WHERE name=ANY($1::text[])",
      [migrations.map((m) => m.name)],
    );
    return (
      rows.length === migrations.length &&
      migrations.every((m) =>
        rows.some((row) => row.name === m.name && row.checksum === m.checksum),
      )
    );
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
    a: Actor | null,
    subject: string,
    action: string,
    details: unknown = {},
  ) {
    const auditId = uid();
    await c.query(
      "INSERT INTO app.audit(id,actor_id,subject_id,action,details) VALUES($1,$2,$3,$4,$5)",
      [auditId, a?.id ?? null, subject, action, JSON.stringify(details)],
    );
    await recordNotifications(c, auditId, subject, action);
  }
  admin(a: Actor) {
    if (a.role !== "admin") fail(403, "Admin access required.");
  }
  async me(id: string, email: string) {
    return transaction(this.db, async (c) => {
      await c.query(
        "INSERT INTO app.profiles(id,email) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email WHERE app.profiles.email IS DISTINCT FROM EXCLUDED.email",
        [id, email],
      );
      const p = (
        await c.query(
          "SELECT id,email,role,active,display_name FROM app.profiles WHERE id=$1",
          [id],
        )
      ).rows[0] as Actor & {
        email: string;
        active: boolean;
        display_name: string;
      };
      if (!p.active) fail(403, "Account is disabled.");
      return p;
    });
  }
  catalog() {
    return this.read(
      `SELECT a.*,p.name AS provider_name,COALESCE((SELECT json_agg(json_build_object('id',s.id,'starts_at',s.starts_at,'cutoff_at',s.cutoff_at) ORDER BY starts_at) FROM app.sessions s WHERE s.activity_id=a.id AND cutoff_at>now()),'[]') AS sessions FROM app.activities a JOIN app.providers p ON p.id=a.provider_id WHERE a.published AND p.status='approved' ORDER BY a.title`,
    );
  }
  children(a: Actor) {
    return this.read(
      "SELECT id,first_name,surname,birth_date::text AS birth_date FROM app.children WHERE parent_id=$1 AND NOT archived ORDER BY first_name",
      [a.id],
    );
  }
  async addChild(
    a: Actor,
    b: { firstName: string; surname: string; birthDate: string },
  ) {
    return transaction(this.db, async (c) => {
      const id = uid();
      await c.query(
        "INSERT INTO app.children(id,parent_id,first_name,surname,birth_date) VALUES($1,$2,$3,$4,$5)",
        [id, a.id, b.firstName, b.surname, b.birthDate],
      );
      await this.audit(c, a, id, "child.created");
      return { id };
    });
  }
  bookings(a: Actor, scope: "all" | "family" | "provider" = "all") {
    return this.read(
      `SELECT b.*,COALESCE((SELECT json_agg(json_build_object('id',x->>'id','first_name',x->>'firstName','surname',x->>'surname')) FROM jsonb_array_elements(b.snapshot->'children') x),'[]') AS children,
      (SELECT json_agg(p) FROM app.payments p WHERE p.booking_id=b.id) AS payments,
      (SELECT json_agg(r) FROM app.refunds r WHERE r.booking_id=b.id) AS refunds
      FROM app.bookings b WHERE
      ($3='family' AND b.parent_id=$1) OR
      ($3='provider' AND ($2='admin' OR ($2='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=b.provider_id AND p.owner_id=$1)))) OR
      ($3='all' AND ($2='admin' OR b.parent_id=$1 OR ($2='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=b.provider_id AND p.owner_id=$1))))
      ORDER BY (b.state IN ('REQUESTED','OFFER_PENDING','PAYMENT_DUE','PAYMENT_CHECKING','CONFIRMED')) DESC,
      CASE b.state WHEN 'REQUESTED' THEN b.response_due_at WHEN 'OFFER_PENDING' THEN (b.offer->>'expiresAt')::timestamptz WHEN 'PAYMENT_DUE' THEN b.payment_due_at WHEN 'PAYMENT_CHECKING' THEN b.created_at END ASC NULLS LAST,
      b.created_at DESC,b.id DESC LIMIT 200`,
      [a.id, a.role, scope],
    );
  }
  async bookingPage(a: Actor, query: BookingPageQuery) {
    const cursor = readBookingCursor(query);
    // Escape LIKE metacharacters: search text is literal, never a wildcard expression.
    const search = query.search
      ? "%" + query.search.replace(/[\\%_]/g, "\\$&") + "%"
      : "";
    const [result] = await this.read(
      `WITH scoped AS MATERIALIZED (
        SELECT b.* FROM app.bookings b WHERE
        ($3='family' AND b.parent_id=$1) OR
        ($3='provider' AND ($2='admin' OR ($2='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=b.provider_id AND p.owner_id=$1)))) OR
        ($3='all' AND ($2='admin' OR b.parent_id=$1 OR ($2='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=b.provider_id AND p.owner_id=$1))))
      ), filtered AS (
        SELECT b.* FROM scoped b WHERE
        ($4='all' OR b.state=$4 OR ($4='attention' AND b.state IN ('REQUESTED','OFFER_PENDING','PAYMENT_DUE','PAYMENT_CHECKING')))
        AND ($5='' OR b.id::text ILIKE $5 OR b.snapshot->>'title' ILIKE $5 OR b.snapshot->>'provider' ILIKE $5)
      ), page AS (
        SELECT b.* FROM filtered b WHERE
        ($6::timestamptz IS NULL OR (b.created_at,b.id)<($6::timestamptz,$7::uuid))
        ORDER BY b.created_at DESC,b.id DESC LIMIT $8
      )
      SELECT
        (SELECT count(*)::int FROM filtered) AS total,
        COALESCE((SELECT jsonb_object_agg(c.state,c.count) FROM (SELECT state,count(*)::int AS count FROM scoped GROUP BY state) c),'{}'::jsonb) AS counts,
        COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object(
          'children',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x->>'id','first_name',x->>'firstName','surname',x->>'surname')) FROM jsonb_array_elements(b.snapshot->'children') x),'[]'::jsonb),
          'payments',(SELECT jsonb_agg(p) FROM app.payments p WHERE p.booking_id=b.id),
          'refunds',(SELECT jsonb_agg(r) FROM app.refunds r WHERE r.booking_id=b.id)
        ) ORDER BY b.created_at DESC,b.id DESC) FROM page b),'[]'::jsonb) AS items`,
      [
        a.id,
        a.role,
        query.scope,
        query.state,
        search,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    const hasMore = result.items.length > query.limit;
    const items = result.items.slice(0, query.limit);
    // JSON timestamps retain PostgreSQL microseconds; converting to JS Date would lose them.
    return {
      items,
      total: result.total,
      counts: result.counts,
      nextCursor: hasMore
        ? nextBookingCursor(query, items[items.length - 1])
        : null,
    };
  }
  async command<T>(
    a: Actor,
    key: string,
    body: unknown,
    fn: (c: Connection) => Promise<T>,
  ): Promise<T> {
    return transaction(this.db, async (c) => {
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
    b: {
      sessionId: string;
      activityVersion: number;
      childIds: string[];
      policyAccepted: boolean;
    },
  ) {
    if (!b.policyAccepted) fail(422, "Accept the cancellation policy.");
    return this.command(a, key, { op: "request", ...b }, async (c) => {
      const s = (
        await c.query(
          `SELECT s.*,a.title,a.version AS activity_version,a.price_fils,a.policy,a.provider_id,a.min_age,a.max_age,p.name AS provider_name FROM app.sessions s JOIN app.activities a ON a.id=s.activity_id JOIN app.providers p ON p.id=a.provider_id WHERE s.id=$1 AND a.published AND p.status='approved'`,
          [b.sessionId],
        )
      ).rows[0];
      if (!s || new Date(s.cutoff_at) <= new Date())
        fail(409, "This session is no longer accepting requests.");
      if (b.activityVersion !== s.activity_version)
        fail(
          409,
          "This listing’s price or terms changed. Refresh the page and review the latest details before requesting.",
        );
      const kids = (
        await c.query(
          "SELECT id,first_name,surname,birth_date::text AS birth_date FROM app.children WHERE parent_id=$1 AND NOT archived AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
          [a.id, b.childIds],
        )
      ).rows;
      if (kids.length !== b.childIds.length)
        fail(422, "Select children from your own account.");
      for (const k of kids) {
        const age = ageAtSession(k.birth_date, s.starts_at);
        if (age < s.min_age || age > s.max_age)
          fail(422, "A selected child is outside the activity age range.");
      }
      const id = uid(),
        due = new Date(
          Math.min(Date.now() + 86400000, new Date(s.cutoff_at).getTime()),
        );
      const snapshot = {
        listingVersion: s.activity_version,
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
      sessionId?: string;
    },
  ) {
    return this.command(a, key, { id, ...b }, async (c) => {
      const booking = (
        await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!booking) fail(404, "Booking not found.");
      const owner = (
        await c.query(
          "SELECT owner_id,status FROM app.providers WHERE id=$1 FOR SHARE",
          [booking.provider_id],
        )
      ).rows[0];
      const parent = booking.parent_id === a.id,
        provider =
          a.role === "provider" &&
          owner?.owner_id === a.id &&
          owner.status === "approved",
        admin = a.role === "admin";
      if (!parent && !provider && !admin) fail(404, "Booking not found.");
      if (b.version !== booking.version)
        fail(409, "This booking changed. Refresh before continuing.");
      let state = booking.state,
        held = booking.held,
        due = booking.payment_due_at,
        offer = booking.offer,
        amount = booking.amount_fils;
      // Lock every affected session in one global order. Opposite-direction
      // offers must not each hold one session while waiting for the other.
      const sessionIds = [
        ...new Set([
          booking.session_id,
          ...(b.action === "accept-offer" && booking.offer?.sessionId
            ? [booking.offer.sessionId]
            : []),
        ]),
      ].sort();
      const sessions = (
        await c.query(
          "SELECT * FROM app.sessions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [sessionIds],
        )
      ).rows;
      let session =
        sessions.find((s) => s.id === booking.session_id) ??
        fail(409, "The booking session is unavailable.");
      const now = new Date();
      let cutoff = new Date(session.cutoff_at);
      const hold = async () => {
        if (owner?.status !== "approved")
          fail(409, "This provider is not currently accepting bookings.");
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
        if (state !== "REQUESTED" || new Date(booking.response_due_at) <= now)
          fail(409, "Request is no longer actionable.");
        await hold();
        state = "PAYMENT_DUE";
      } else if (b.action === "offer") {
        if (!provider && !admin) fail(403, "Provider access required.");
        if (state !== "REQUESTED" || new Date(booking.response_due_at) <= now)
          fail(409, "Request is no longer actionable.");
        if (!b.amountFils) fail(422, "Enter an offer total.");
        const target = (
          await c.query(
            "SELECT * FROM app.sessions WHERE id=$1 AND activity_id=$2",
            [b.sessionId || session.id, session.activity_id],
          )
        ).rows[0];
        if (!target || new Date(target.cutoff_at) <= now)
          fail(409, "The proposed session is unavailable.");
        offer = {
          sessionId: target.id,
          startsAt: target.starts_at,
          amountFils: b.amountFils,
          reason: b.reason,
          version: booking.version + 1,
          expiresAt: target.cutoff_at,
        };
        state = "OFFER_PENDING";
      } else if (b.action === "accept-offer") {
        if (!parent) fail(403, "Parent approval required.");
        if (state !== "OFFER_PENDING" || !offer) fail(409, "No current offer.");
        amount = offer.amountFils;
        if (offer.sessionId && offer.sessionId !== session.id) {
          const target = sessions.find(
            (s) =>
              s.id === offer.sessionId && s.activity_id === session.activity_id,
          );
          if (!target) fail(409, "Offered session is unavailable.");
          const ages = (
            await c.query(
              "SELECT x.birth_date::text AS birth_date,a.min_age,a.max_age FROM app.participants j JOIN app.children x ON x.id=j.child_id JOIN app.activities a ON a.id=$2 WHERE j.booking_id=$1",
              [id, session.activity_id],
            )
          ).rows;
          for (const child of ages) {
            const age = ageAtSession(child.birth_date, target.starts_at);
            if (age < child.min_age || age > child.max_age)
              fail(409, "A child is outside the offered session age range.");
          }
          session = target;
          cutoff = new Date(target.cutoff_at);
          await c.query(
            "UPDATE app.participants SET session_id=$2 WHERE booking_id=$1",
            [id, target.id],
          );
          await c.query(
            "UPDATE app.bookings SET session_id=$2,snapshot=$3 WHERE id=$1",
            [
              id,
              target.id,
              JSON.stringify({
                ...booking.snapshot,
                originalStartsAt: booking.snapshot.startsAt,
                startsAt: target.starts_at,
              }),
            ],
          );
        }
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
        if (state !== "PAYMENT_DUE" || !due || new Date(due) <= now)
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
          fail(409, "Finance workflow is disabled until ownership is agreed.");
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
    });
  }
  providers(a: Actor) {
    return this.read(
      "SELECT * FROM app.providers WHERE owner_id=$1 OR $2='admin' ORDER BY created_at DESC",
      [a.id, a.role],
    );
  }
  async apply(a: Actor, b: { name: string; description: string }) {
    return transaction(this.db, async (c) => {
      const id = uid();
      await c.query(
        "INSERT INTO app.providers(id,owner_id,name,description) VALUES($1,$2,$3,$4)",
        [id, a.id, b.name, b.description],
      );
      await this.audit(c, a, id, "provider.applied");
      return { id };
    });
  }
  async approve(a: Actor, id: string, status: string) {
    this.admin(a);
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
      await this.audit(c, a, id, "provider." + status);
      return p;
    });
  }
  async createActivity(a: Actor, b: Record<string, any>) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const provider = (
        await c.query(
          "SELECT id,status FROM app.providers WHERE id=$1 FOR SHARE",
          [b.providerId],
        )
      ).rows[0];
      if (!provider) fail(404, "Provider not found.");
      if (b.published && provider.status !== "approved")
        fail(409, "Only approved providers can publish activities.");
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
    const [providers, refunds, subscriptions, contacts, campaigns, audit] =
      await Promise.all([
        this.providers(a),
        this.read("SELECT * FROM app.refunds ORDER BY status"),
        this.read(
          "SELECT s.*,p.name FROM app.subscriptions s JOIN app.providers p ON p.id=s.provider_id",
        ),
        this.read(
          "SELECT id,name,right(phone,4) AS phone_suffix,marketing,suppressed FROM app.contacts ORDER BY created_at DESC LIMIT 200",
        ),
        this.read("SELECT * FROM app.campaigns ORDER BY created_at DESC"),
        this.read("SELECT * FROM app.audit ORDER BY created_at DESC LIMIT 100"),
      ]);
    return {
      providers,
      refunds,
      subscriptions,
      contacts,
      campaigns,
      audit,
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
    if (!["provider", "admin"].includes(a.role))
      fail(403, "Provider access required.");
    return transaction(this.db, async (c) => {
      const activity = (
        await c.query(
          "SELECT a.provider_id FROM app.activities a JOIN app.providers p ON p.id=a.provider_id WHERE a.id=$1 AND p.owner_id=$2",
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

  async updateProfile(a: Actor, name: string) {
    return transaction(this.db, async (c) => {
      await c.query("UPDATE app.profiles SET display_name=$2 WHERE id=$1", [
        a.id,
        name,
      ]);
      await this.audit(c, a, a.id, "profile.updated");
      return { saved: true };
    });
  }
  async updateChild(
    a: Actor,
    id: string,
    b: { firstName: string; surname: string; birthDate: string } | null,
  ) {
    return transaction(this.db, async (c) => {
      const child = (
        await c.query(
          "SELECT id FROM app.children WHERE id=$1 AND parent_id=$2 AND NOT archived FOR UPDATE",
          [id, a.id],
        )
      ).rows[0];
      if (!child) fail(404, "Child not found.");
      const active = (
        await c.query(
          "SELECT 1 FROM app.participants WHERE child_id=$1 AND active LIMIT 1",
          [id],
        )
      ).rows[0];
      if (active)
        fail(
          409,
          "This child has an active booking. Contact support before changing their profile.",
        );
      if (b)
        await c.query(
          "UPDATE app.children SET first_name=$2,surname=$3,birth_date=$4 WHERE id=$1",
          [id, b.firstName, b.surname, b.birthDate],
        );
      else
        await c.query("UPDATE app.children SET archived=true WHERE id=$1", [
          id,
        ]);
      await this.audit(c, a, id, b ? "child.updated" : "child.archived");
      return { id };
    });
  }
  managementCatalog(a: Actor) {
    return this.read(
      `SELECT a.*,p.name AS provider_name,COALESCE((SELECT json_agg(s ORDER BY starts_at) FROM app.sessions s WHERE s.activity_id=a.id),'[]') AS sessions FROM app.activities a JOIN app.providers p ON p.id=a.provider_id WHERE $2='admin' OR ($2='provider' AND p.owner_id=$1) ORDER BY a.title`,
      [a.id, a.role],
    );
  }
  async editActivity(a: Actor, id: string, b: Record<string, any>) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const old = (
        await c.query("SELECT * FROM app.activities WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!old) fail(404, "Activity not found.");
      if (old.version !== b.version)
        fail(409, "This listing changed. Refresh and try again.");
      if (b.published) {
        const provider = (
          await c.query(
            "SELECT status FROM app.providers WHERE id=$1 FOR SHARE",
            [old.provider_id],
          )
        ).rows[0];
        if (provider?.status !== "approved")
          fail(409, "Only approved providers can publish activities.");
      }
      await c.query(
        "UPDATE app.activities SET title=$2,description=$3,category=$4,area=$5,min_age=$6,max_age=$7,price_fils=$8,policy=$9,published=$10,version=version+1 WHERE id=$1",
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
          b.published,
        ],
      );
      await this.audit(c, a, id, "activity.updated", {
        previousVersion: old.version,
      });
      return { id };
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
      await this.audit(c, a, id, "session.added");
      return { id: sessionId };
    });
  }
  corrections(a: Actor) {
    return this.read(
      `SELECT c.*,a.title,p.name AS provider_name FROM app.corrections c JOIN app.activities a ON a.id=c.activity_id JOIN app.providers p ON p.id=c.provider_id WHERE $2='admin' OR ($2='provider' AND p.owner_id=$1) ORDER BY c.status,c.id`,
      [a.id, a.role],
    );
  }
  async reviewCorrection(a: Actor, id: string, status: string, note: string) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const row = (
        await c.query(
          "UPDATE app.corrections SET status=$2,reviewed_by=$3,review_note=$4 WHERE id=$1 AND status='pending' RETURNING id",
          [id, status, a.id, note],
        )
      ).rows[0];
      if (!row) fail(409, "Correction is already reviewed or unavailable.");
      await this.audit(c, a, id, "correction." + status, { note });
      return row;
    });
  }
  contents(a?: Actor) {
    return this.read(
      "SELECT * FROM app.content WHERE published OR $1=true ORDER BY slug",
      [a?.role === "admin"],
    );
  }
  async saveContent(
    a: Actor,
    slug: string,
    b: { title: string; body: string; published: boolean; version: number },
  ) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      await c.query(
        "INSERT INTO app.content(slug,title,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [slug, b.title, b.body],
      );
      const row = (
        await c.query("SELECT * FROM app.content WHERE slug=$1 FOR UPDATE", [
          slug,
        ])
      ).rows[0];
      if (row.version !== b.version)
        fail(409, "Content changed. Reload the latest version.");
      await c.query(
        "UPDATE app.content SET title=$2,body=$3,published=$4,version=version+1,updated_at=now() WHERE slug=$1",
        [slug, b.title, b.body, b.published],
      );
      await this.audit(c, a, a.id, "content.saved", { slug });
      return { slug };
    });
  }
  tickets(a: Actor) {
    return this.read(
      `SELECT id,topic,message,status,reply,created_at,updated_at FROM app.support WHERE owner_id=$1 OR $2='admin' ORDER BY created_at DESC LIMIT 200`,
      [a.id, a.role],
    );
  }
  async ticket(a: Actor, topic: string, message: string) {
    return transaction(this.db, async (c) => {
      const id = uid();
      await c.query(
        "INSERT INTO app.support(id,owner_id,topic,message) VALUES($1,$2,$3,$4)",
        [id, a.id, topic, message],
      );
      await this.audit(c, a, id, "support.created");
      return { id };
    });
  }
  async replyTicket(a: Actor, id: string, status: string, reply: string) {
    this.admin(a);
    return transaction(this.db, async (c) => {
      const row = (
        await c.query(
          "UPDATE app.support SET status=$2,reply=$3,updated_at=now() WHERE id=$1 RETURNING id",
          [id, status, reply],
        )
      ).rows[0];
      if (!row) fail(404, "Support request not found.");
      await this.audit(c, a, id, "support.updated");
      return row;
    });
  }
  async requestDeletion(a: Actor) {
    return transaction(this.db, async (c) => {
      await c.query(
        "INSERT INTO app.deletion_requests(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
        [a.id],
      );
      await this.audit(c, a, a.id, "account.deletion_requested");
      return {
        status: "pending",
        message:
          "The team will review outstanding bookings and record-retention requirements.",
      };
    });
  }
  async history(a: Actor, id: string) {
    const visible = (
      await this.read(
        `SELECT b.id FROM app.bookings b WHERE b.id=$1 AND (b.parent_id=$2 OR $3='admin' OR ($3='provider' AND EXISTS(SELECT 1 FROM app.providers p WHERE p.id=b.provider_id AND p.owner_id=$2)))`,
        [id, a.id, a.role],
      )
    )[0];
    if (!visible) fail(404, "Booking not found.");
    return this.read(
      "SELECT action,created_at FROM app.audit WHERE subject_id=$1 ORDER BY created_at",
      [id],
    );
  }
  async expire() {
    return transaction(this.db, async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM app.bookings WHERE state='PAYMENT_DUE' AND payment_due_at<=now() ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
        )
      ).rows;
      if (rows.length)
        await c.query(
          "SELECT id FROM app.sessions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [[...new Set(rows.map((b) => b.session_id))].sort()],
        );
      for (const b of rows) {
        await c.query(
          "UPDATE app.sessions SET allocated=allocated-$2 WHERE id=$1",
          [b.session_id, b.quantity],
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
        await this.audit(c, null, b.id, "booking.expired");
      }
      return rows.length;
    });
  }
}
