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
    await c.query(
      "INSERT INTO app.audit(id,actor_id,subject_id,action,details) VALUES($1,$2,$3,$4,$5)",
      [uid(), a.id, subject, action, JSON.stringify(details)],
    );
  }
  admin(a: Actor) {
    if (a.role !== "admin") fail(403, "Admin access required.");
  }
  async me(id: string, email: string) {
    return transaction(this.db, async (c) => {
      await c.query(
        "INSERT INTO app.profiles(id,email) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
        [id, email],
      );
      const p = (
        await c.query(
          "SELECT id,email,role,active FROM app.profiles WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!p.active) fail(403, "Account is disabled.");
      return p;
    });
  }
  catalog() {
    return this.read(
      `SELECT a.*,p.name AS provider_name,COALESCE((SELECT json_agg(s ORDER BY starts_at) FROM app.sessions s WHERE s.activity_id=a.id AND cutoff_at>now()),'[]') AS sessions FROM app.activities a JOIN app.providers p ON p.id=a.provider_id WHERE a.published AND p.status='approved' ORDER BY a.title`,
    );
  }
  children(a: Actor) {
    return this.read(
      "SELECT id,first_name,surname,birth_date FROM app.children WHERE parent_id=$1 ORDER BY first_name",
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
  bookings(a: Actor) {
    return this.read(
      `SELECT b.*,COALESCE((SELECT json_agg(json_build_object('id',x.id,'first_name',x.first_name,'surname',x.surname)) FROM app.participants j JOIN app.children x ON x.id=j.child_id WHERE j.booking_id=b.id),'[]') AS children,(SELECT json_agg(p) FROM app.payments p WHERE p.booking_id=b.id) AS payments,(SELECT json_agg(r) FROM app.refunds r WHERE r.booking_id=b.id) AS refunds FROM app.bookings b WHERE $2='admin' OR b.parent_id=$1 OR EXISTS(SELECT 1 FROM app.providers p WHERE p.id=b.provider_id AND p.owner_id=$1) ORDER BY b.created_at DESC LIMIT 200`,
      [a.id, a.role],
    );
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
    b: { sessionId: string; childIds: string[]; policyAccepted: boolean },
  ) {
    if (!b.policyAccepted) fail(422, "Accept the cancellation policy.");
    return this.command(a, key, { op: "request", ...b }, async (c) => {
      const s = (
        await c.query(
          `SELECT s.*,a.title,a.price_fils,a.policy,a.provider_id,a.min_age,a.max_age,p.name AS provider_name FROM app.sessions s JOIN app.activities a ON a.id=s.activity_id JOIN app.providers p ON p.id=a.provider_id WHERE s.id=$1 AND a.published AND p.status='approved'`,
          [b.sessionId],
        )
      ).rows[0];
      if (!s || new Date(s.cutoff_at) <= new Date())
        fail(409, "This session is no longer accepting requests.");
      const kids = (
        await c.query(
          "SELECT * FROM app.children WHERE parent_id=$1 AND id=ANY($2::uuid[])",
          [a.id, b.childIds],
        )
      ).rows;
      if (kids.length !== b.childIds.length)
        fail(422, "Select children from your own account.");
      for (const k of kids) {
        const start = new Date(s.starts_at),
          dob = new Date(k.birth_date);
        let age = start.getUTCFullYear() - dob.getUTCFullYear();
        if (
          start.getUTCMonth() < dob.getUTCMonth() ||
          (start.getUTCMonth() === dob.getUTCMonth() &&
            start.getUTCDate() < dob.getUTCDate())
        )
          age--;
        if (age < s.min_age || age > s.max_age)
          fail(422, "A selected child is outside the activity age range.");
      }
      const id = uid(),
        due = new Date(
          Math.min(Date.now() + 86400000, new Date(s.cutoff_at).getTime()),
        );
      const snapshot = {
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
    return this.command(a, key, { id, ...b }, async (c) => {
      const booking = (
        await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!booking) fail(404, "Booking not found.");
      const owner = (
        await c.query("SELECT owner_id,status FROM app.providers WHERE id=$1", [
          booking.provider_id,
        ])
      ).rows[0];
      const parent = booking.parent_id === a.id,
        provider = owner?.owner_id === a.id && owner.status === "approved",
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
        if (state !== "OFFER_PENDING" || !offer) fail(409, "No current offer.");
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
  async expire() {
    return transaction(this.db, async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM app.bookings WHERE state='PAYMENT_DUE' AND payment_due_at<now() ORDER BY id FOR UPDATE SKIP LOCKED",
        )
      ).rows;
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
      }
      return rows.length;
    });
  }
}
