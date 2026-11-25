import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/migrations.js";
import { Platform, type Actor } from "../src/platform.js";
import { StripeCheckout } from "../src/stripe-checkout.js";
import { databaseFor } from "./support/database.js";
import { grantFixtureRoles } from "./support/permissions.js";
import { createApp } from "../src/app.js";

const ref="abcdefghij1234567890";
const env={APP_ENV:"staging",STRIPE_TEST_ENABLED:"true",STRIPE_TEST_SECRET_KEY:"sk_test_synthetic_only",
  STRIPE_TEST_PROJECT_REF:ref,SUPABASE_URL:`https://${ref}.supabase.co`,
  DATABASE_URL:`postgresql://postgres.${ref}:synthetic@aws-0-region.pooler.supabase.com:5432/postgres`,
  WEB_ORIGIN:"http://localhost:3000"};

test("staging Checkout is parent scoped, idempotent, server verified and auditable",async()=>{
  const pg=new PGlite();
  try {
    const db=databaseFor(pg);
    await migrate(db);
    const p=new Platform(db);
    const parent:Actor={id:randomUUID(),role:"parent"};
    const other:Actor={id:randomUUID(),role:"parent"};
    const provider:Actor={id:randomUUID(),role:"provider"};
    const admin:Actor={id:randomUUID(),role:"admin"};
    for(const actor of [parent,other,provider,admin]) {
      await p.me(actor.id,`${actor.role}-${actor.id}@example.invalid`);
      await grantFixtureRoles(p,actor);
      await pg.query("UPDATE app.profiles SET role=$2 WHERE id=$1",[actor.id,actor.role]);
    }
    const business=await p.apply(provider,{name:"Synthetic provider",description:"Test only"});
    await p.approve(admin,business.id,"approved");
    const activity=await p.createActivity(admin,{
      providerId:business.id,title:"Synthetic activity",description:"Test only",category:"Arts",area:"Dubai",
      minAge:1,maxAge:17,priceFils:25000,policy:"Synthetic policy",published:true,
      startsAt:"2030-05-01T12:00:00Z",cutoffAt:"2030-04-30T12:00:00Z",capacity:2,
    });
    const child=await p.addChild(parent,{firstName:"Synthetic",surname:"Child",birthDate:"2018-01-01"});
    const booking=await p.request(parent,"stripe-test-create",{
      sessionId:activity.sessionId,activityVersion:1,childIds:[child.id],policyAccepted:true,
    });
    await p.act(provider,"stripe-test-accept",booking.id,{action:"accept",version:1});
    const sessionId="cs_test_synthetic123";
    let posts=0,gets=0,paid=false,wrongAmount=false;
    const request:typeof fetch=async (_url,init)=>{
      if(init?.method === "POST") { posts++; return Response.json({
        id:sessionId,url:"https://checkout.stripe.com/c/pay/synthetic",livemode:false,
        client_reference_id:booking.id,
      }); }
      gets++;
      return Response.json({id:sessionId,livemode:false,client_reference_id:booking.id,
        amount_total:wrongAmount?25001:25000,currency:"aed",status:paid?"complete":"open",
        payment_status:paid?"paid":"unpaid",metadata:{booking_id:booking.id}});
    };
    const checkout=new StripeCheckout(db,env,request);
    await assert.rejects(()=>new StripeCheckout(db,{...env,APP_ENV:"production"},request).start(parent,booking.id),/staging/);
    await assert.rejects(()=>checkout.start(other,booking.id),/not found/);
    await assert.rejects(()=>checkout.reconcile(other,booking.id),/not found/);
    const first=await checkout.start(parent,booking.id);
    assert.equal(first.url,"https://checkout.stripe.com/c/pay/synthetic");
    assert.deepEqual(await checkout.start(parent,booking.id),first);
    assert.equal(posts,1);
    assert.deepEqual(await checkout.reconcile(parent,booking.id),{state:"PAYMENT_DUE"});
    paid=true; wrongAmount=true;
    assert.deepEqual(await checkout.reconcile(parent,booking.id),{state:"PAYMENT_DUE"});
    wrongAmount=false;
    assert.deepEqual(await checkout.reconcile(parent,booking.id),{state:"CONFIRMED"});
    assert.deepEqual(await checkout.reconcile(parent,booking.id),{state:"CONFIRMED"});
    assert.equal(gets,3);
    assert.equal((await p.booking(parent,booking.id)).state,"CONFIRMED");
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.payments WHERE booking_id=$1 AND status='verified'",[booking.id]))[0].n,1);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.audit WHERE subject_id=$1 AND action='stripe_test.verified'",[booking.id]))[0].n,1);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.outbox WHERE booking_id=$1 AND event='CONFIRMED'",[booking.id]))[0].n,1);
    const secondChild=await p.addChild(parent,{firstName:"Second",surname:"Synthetic",birthDate:"2017-01-01"});
    const second=await p.request(parent,"stripe-test-second",{
      sessionId:activity.sessionId,activityVersion:1,childIds:[secondChild.id],policyAccepted:true,
    });
    await p.act(provider,"stripe-test-accept-second",second.id,{action:"accept",version:1});
    const lateSession="cs_test_synthetic456";
    const lateRequest:typeof fetch=async (_url,init)=>Response.json(init?.method === "POST" ? {
      id:lateSession,url:"https://checkout.stripe.com/c/pay/late",livemode:false,client_reference_id:second.id,
    } : {id:lateSession,livemode:false,client_reference_id:second.id,amount_total:25000,
      currency:"aed",status:"complete",payment_status:"paid",metadata:{booking_id:second.id}});
    const lateCheckout=new StripeCheckout(db,env,lateRequest);
    await lateCheckout.start(parent,second.id);
    await pg.query("UPDATE app.bookings SET payment_due_at=now()-interval '1 minute' WHERE id=$1",[second.id]);
    await assert.rejects(()=>lateCheckout.reconcile(parent,second.id),/no place is confirmed/);
    assert.equal((await p.read("SELECT status FROM app.stripe_test_checkouts WHERE booking_id=$1",[second.id]))[0].status,"exception");
    assert.equal((await p.booking(parent,second.id)).state,"PAYMENT_DUE");
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.payments WHERE booking_id=$1",[second.id]))[0].n,0);
    assert.equal((await p.read("SELECT count(*)::int AS n FROM app.audit WHERE subject_id=$1 AND action='stripe_test.late_paid'",[second.id]))[0].n,1);
  } finally { await pg.close(); }
});

test("HTTP request, provider acceptance and parent Stripe test return stay isolated",async()=>{
  const pg=new PGlite();
  let server:ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  try {
    const db=databaseFor(pg);
    await migrate(db);
    const p=new Platform(db);
    const parent:Actor={id:randomUUID(),role:"parent"};
    const provider:Actor={id:randomUUID(),role:"provider"};
    const other:Actor={id:randomUUID(),role:"parent"};
    const admin:Actor={id:randomUUID(),role:"admin"};
    for(const actor of [parent,provider,other,admin]) {
      await p.me(actor.id,`${actor.role}-${actor.id}@example.invalid`);
      await grantFixtureRoles(p,actor);
      await p.read("UPDATE app.profiles SET role=$2 WHERE id=$1",[actor.id,actor.role]);
    }
    const business=await p.apply(provider,{name:"Synthetic partner",description:"HTTP fixture only"});
    await p.approve(admin,business.id,"approved");
    const activity=await p.createActivity(admin,{
      providerId:business.id,title:"Synthetic session",description:"HTTP fixture",category:"Arts",area:"Dubai",
      minAge:1,maxAge:17,priceFils:25000,policy:"Synthetic policy",published:true,
      startsAt:"2030-05-01T12:00:00Z",cutoffAt:"2030-04-30T12:00:00Z",capacity:1,
    });
    const child=await p.addChild(parent,{firstName:"Synthetic",surname:"Child",birthDate:"2018-01-01"});
    let bookingId="",paid=false,posts=0;
    const sessionId="cs_test_httpflow123";
    const stripeRequest:typeof fetch=async (_url,init)=>{
      if(init?.method === "POST") { posts++; return Response.json({id:sessionId,
        url:"https://checkout.stripe.com/c/pay/synthetic",livemode:false,client_reference_id:bookingId}); }
      return Response.json({id:sessionId,livemode:false,client_reference_id:bookingId,
        amount_total:25000,currency:"aed",status:paid?"complete":"open",
        payment_status:paid?"paid":"unpaid",metadata:{booking_id:bookingId}});
    };
    const checkout=new StripeCheckout(db,env,stripeRequest);
    const actors={parent,provider,other,admin};
    const auth=async(token:string)=>{
      const actor=actors[token as keyof typeof actors];
      if(!actor) throw Object.assign(new Error("Invalid synthetic token"),{status:401});
      return {id:actor.id,email:"synthetic@example.invalid",emailVerified:true};
    };
    server=createApp("http://localhost:3000",p,auth,checkout).listen(0,"127.0.0.1");
    await once(server,"listening");
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const call=(path:string,token:string,body?:unknown)=>fetch(base+path,{
      method:body===undefined?"GET":"POST",
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},
      body:body===undefined?undefined:JSON.stringify(body),
    });
    const submitted=await call("/bookings","parent",{sessionId:activity.sessionId,activityVersion:1,
      childIds:[child.id],policyAccepted:true});
    assert.equal(submitted.status,201);
    bookingId=(await submitted.json()).id;
    assert.equal((await call(`/bookings/${bookingId}/stripe-test/checkout`,"parent",{})).status,409);
    const accepted=await call(`/bookings/${bookingId}/actions`,"provider",{action:"accept",version:1});
    assert.equal(accepted.status,200);
    assert.equal((await accepted.json()).state,"PAYMENT_DUE");
    assert.equal((await call(`/bookings/${bookingId}/stripe-test/checkout`,"other",{})).status,404);
    assert.equal((await call(`/bookings/${bookingId}/stripe-test/reconcile`,"other",{})).status,404);
    const started=await call(`/bookings/${bookingId}/stripe-test/checkout`,"parent",{});
    assert.equal(started.status,200);
    assert.equal((await started.json()).url,"https://checkout.stripe.com/c/pay/synthetic");
    assert.equal((await call(`/bookings/${bookingId}/stripe-test/checkout`,"parent",{})).status,200);
    assert.equal(posts,1);
    const unpaid=await call(`/bookings/${bookingId}/stripe-test/reconcile`,"parent",{});
    assert.equal(unpaid.status,200);
    assert.equal((await unpaid.json()).state,"PAYMENT_DUE");
    paid=true;
    const verified=await call(`/bookings/${bookingId}/stripe-test/reconcile`,"parent",{});
    assert.equal(verified.status,200);
    assert.equal((await verified.json()).state,"CONFIRMED");
    assert.equal((await (await call(`/bookings/${bookingId}`,"parent")).json()).state,"CONFIRMED");
    assert.equal((await (await call(`/bookings/${bookingId}`,"provider")).json()).state,"CONFIRMED");
    assert.equal((await call(`/bookings/${bookingId}/stripe-test/checkout`,"parent",{})).status,409);
    assert.equal((await p.read("SELECT count(1)::int AS n FROM app.payments WHERE booking_id=$1",[bookingId]))[0].n,1);
  } finally {
    if(server) {
      server.closeAllConnections();
      await new Promise<void>(resolve=>server!.close(()=>resolve()));
    }
    await pg.close();
  }
});
