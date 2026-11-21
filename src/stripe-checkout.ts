import { randomUUID } from "node:crypto";
import { transaction, type Database } from "./database.js";
import { fail, type Actor } from "./platform.js";
import { recordNotifications } from "./notifications.js";
import { createStripeTestCheckout, stripeTestConfig, verifyStripeTestCheckout } from "./stripe-test.js";

/** Staging-only, parent-scoped Checkout orchestration. Never accepts payment status from the browser. */
export class StripeCheckout {
  constructor(
    private readonly db: Database,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly request: typeof fetch = fetch,
  ) {}

  private enabled() {
    if (!stripeTestConfig(this.env).enabled) fail(503, "Stripe test checkout is unavailable.");
  }

  async start(actor: Actor, id: string) {
    this.enabled();
    const booking = await transaction(this.db, async c => {
      const b = (await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (!b || b.parent_id !== actor.id) fail(404,"Booking not found.");
      if (b.state !== "PAYMENT_DUE" || !b.held || !b.payment_due_at ||
          new Date(b.payment_due_at).getTime() - Date.now() < 1800000)
        fail(409,"The payment window is closed or too short for Checkout.");
      const previous = (await c.query("SELECT * FROM app.stripe_test_checkouts WHERE booking_id=$1 FOR UPDATE",[id])).rows[0];
      if (previous) {
        if (previous.booking_version !== b.version || previous.amount_fils !== b.amount_fils)
          fail(409,"This booking changed. Contact support before retrying payment.");
        if (previous.status === "open" && previous.checkout_url)
          return {existing:{url:previous.checkout_url},booking:null};
        if (previous.status !== "creating") fail(409,"This Checkout attempt is no longer actionable.");
      } else {
        await c.query(`INSERT INTO app.stripe_test_checkouts(booking_id,booking_version,amount_fils)
          VALUES($1,$2,$3)`,[id,b.version,b.amount_fils]);
      }
      return {existing:null,booking:{
        id:b.id,version:b.version,amountFils:b.amount_fils,
        paymentDueAt:new Date(b.payment_due_at).toISOString(),
        title:String(b.snapshot?.title ?? "Activity booking"),
      }};
    });
    if (booking.existing) return booking.existing;
    const session = await createStripeTestCheckout(booking.booking!,this.env,this.request);
    return transaction(this.db,async c => {
      const b=(await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE",[id])).rows[0];
      const attempt=(await c.query("SELECT * FROM app.stripe_test_checkouts WHERE booking_id=$1 FOR UPDATE",[id])).rows[0];
      if (!b || b.parent_id !== actor.id) fail(404,"Booking not found.");
      if (attempt?.status === "open" && attempt.session_id === session.id && attempt.checkout_url)
        return {url:attempt.checkout_url};
      if (b.state !== "PAYMENT_DUE" || !b.held ||
          b.version !== booking.booking!.version || b.amount_fils !== booking.booking!.amountFils ||
          new Date(b.payment_due_at).getTime() <= Date.now() || !attempt || attempt.status !== "creating")
        fail(409,"Booking changed while Checkout was being prepared. Refresh and contact support.");
      await c.query(`UPDATE app.stripe_test_checkouts SET session_id=$2,checkout_url=$3,
        status='open',updated_at=now() WHERE booking_id=$1`,[id,session.id,session.url]);
      return {url:session.url};
    });
  }

  async reconcile(actor: Actor, id: string, source: "parent" | "worker" = "parent") {
    this.enabled();
    const snapshot=await transaction(this.db,async c => {
      const b=(await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (!b || b.parent_id !== actor.id) fail(404,"Booking not found.");
      const attempt=(await c.query("SELECT * FROM app.stripe_test_checkouts WHERE booking_id=$1 FOR UPDATE",[id])).rows[0];
      if (!attempt || !attempt.session_id) fail(409,"No test Checkout session exists for this booking.");
      if (attempt.status === "verified" && b.state === "CONFIRMED") return {done:true as const};
      if (attempt.status !== "open") fail(409,"Checkout is not awaiting verification.");
      return {done:false as const,sessionId:attempt.session_id,amountFils:attempt.amount_fils,
        version:attempt.booking_version};
    });
    if (snapshot.done) return {state:"CONFIRMED" as const};
    const paid=await verifyStripeTestCheckout(snapshot.sessionId,{id,amountFils:snapshot.amountFils},this.env,this.request);
    if (!paid) return {state:"PAYMENT_DUE" as const};
    const result=await transaction(this.db,async c => {
      const b=(await c.query("SELECT * FROM app.bookings WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (!b || b.parent_id !== actor.id) fail(404,"Booking not found.");
      const attempt=(await c.query("SELECT * FROM app.stripe_test_checkouts WHERE booking_id=$1 FOR UPDATE",[id])).rows[0];
      if (attempt?.status === "verified" && b.state === "CONFIRMED") return {state:"CONFIRMED" as const};
      if (!attempt || attempt.status !== "open" || attempt.session_id !== snapshot.sessionId ||
          attempt.booking_version !== snapshot.version || attempt.amount_fils !== snapshot.amountFils)
        fail(409,"Checkout attempt changed. Contact support.");
      if (b.state !== "PAYMENT_DUE" || !b.held || b.version !== snapshot.version ||
          b.amount_fils !== snapshot.amountFils || new Date(b.payment_due_at).getTime() <= Date.now()) {
        await c.query("UPDATE app.stripe_test_checkouts SET status='exception',updated_at=now() WHERE booking_id=$1",[id]);
        await c.query("INSERT INTO app.audit(id,subject_id,action,details) VALUES($1,$2,'stripe_test.late_paid',$3)",
          [randomUUID(),id,JSON.stringify({source,mode:"stripe_test",sessionId:snapshot.sessionId,state:b.state})]);
        return {state:"EXCEPTION" as const};
      }
      await c.query(`INSERT INTO app.payments(id,booking_id,amount_fils,reference,status)
        VALUES($1,$2,$3,$4,'verified')`,[randomUUID(),id,snapshot.amountFils,`STRIPE-TEST:${snapshot.sessionId}`]);
      await c.query("UPDATE app.bookings SET state='CONFIRMED',version=version+1 WHERE id=$1",[id]);
      await c.query(`UPDATE app.stripe_test_checkouts SET status='verified',checkout_url=NULL,
        verified_at=now(),updated_at=now() WHERE booking_id=$1`,[id]);
      const auditId=randomUUID();
      await c.query("INSERT INTO app.audit(id,actor_id,subject_id,action,details) VALUES($1,$2,$3,'stripe_test.verified',$4)",
        [auditId,source === "parent" ? actor.id : null,id,JSON.stringify({source,mode:"stripe_test_server_retrieval",sessionId:snapshot.sessionId,previous:b.state,state:"CONFIRMED"})]);
      await c.query("INSERT INTO app.outbox(id,booking_id,event) VALUES($1,$2,'CONFIRMED')",[randomUUID(),id]);
      await recordNotifications(c,auditId,id,"CONFIRMED");
      return {state:"CONFIRMED" as const};
    });
    if (result.state === "EXCEPTION")
      fail(409,"Test payment was detected after the booking changed or expired. Contact support; no place is confirmed.");
    return result;
  }

  /** Poll active staging sessions before the expiry sweep; browser return is not required. */
  async reconcileOpen(limit = 20) {
    if (!stripeTestConfig(this.env).enabled) return 0;
    const c=await this.db.connect();
    let rows:Record<string,any>[];
    try {
      rows=(await c.query(`SELECT t.booking_id,b.parent_id FROM app.stripe_test_checkouts t
        JOIN app.bookings b ON b.id=t.booking_id WHERE t.status='open'
        ORDER BY t.updated_at,t.booking_id LIMIT $1`,[limit])).rows;
    } finally { c.release(); }
    let confirmed=0;
    for(const row of rows) {
      try {
        const result=await this.reconcile({id:row.parent_id,role:"parent"},row.booking_id,"worker");
        if(result.state === "CONFIRMED") confirmed++;
      } catch { /* Keep the attempt open for retry or a durable late-payment exception. */ }
      finally {
        const connection=await this.db.connect();
        try { await connection.query(`UPDATE app.stripe_test_checkouts SET updated_at=now()
          WHERE booking_id=$1 AND status='open'`,[row.booking_id]); }
        finally { connection.release(); }
      }
    }
    return confirmed;
  }
}
