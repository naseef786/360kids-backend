import test from "node:test";
import assert from "node:assert/strict";
import { createStripeTestCheckout, stripeTestConfig, verifyStripeTestCheckout } from "../src/stripe-test.js";

const ref = "abcdefghij1234567890";
const bookingId = "12345678-90ab-4cde-8f12-34567890abcd";
const env = {
  APP_ENV:"staging",STRIPE_TEST_ENABLED:"true",STRIPE_TEST_SECRET_KEY:"sk_test_synthetic_only",
  STRIPE_TEST_PROJECT_REF:ref,SUPABASE_URL:`https://${ref}.supabase.co`,
  DATABASE_URL:`postgresql://postgres.${ref}:synthetic@aws-0-region.pooler.supabase.com:5432/postgres`,
  WEB_ORIGIN:"http://localhost:3000",
};
const session = {
  id:"cs_test_synthetic123",url:"https://checkout.stripe.com/c/pay/synthetic",livemode:false,
  client_reference_id:bookingId,amount_total:25000,currency:"aed",payment_status:"unpaid",
  status:"open",metadata:{booking_id:bookingId,booking_version:"2"},
};

test("Stripe test transport fails closed outside a matching staging target", () => {
  assert.deepEqual(stripeTestConfig({}),{enabled:false});
  assert.throws(()=>stripeTestConfig({...env,APP_ENV:"production"}),/staging/);
  assert.throws(()=>stripeTestConfig({...env,STRIPE_TEST_SECRET_KEY:"sk_live_synthetic"}),/test secret key/);
  assert.throws(()=>stripeTestConfig({...env,STRIPE_TEST_SECRET_KEY:"rk_live_synthetic"}),/test secret key/);
  assert.equal(stripeTestConfig({...env,STRIPE_TEST_SECRET_KEY:"rk_test_synthetic"}).enabled,true);
  assert.throws(()=>stripeTestConfig({...env,STRIPE_TEST_PROJECT_REF:"otherproject123"}),/do not match/);
  assert.throws(()=>stripeTestConfig({...env,WEB_ORIGIN:"http://example.com"}),/HTTPS/);
});

test("Checkout creation uses server amount, AED, no child data, and a stable idempotency key", async () => {
  let calls=0;
  const request:typeof fetch=async (url,init) => {
    calls++;
    assert.equal(url,"https://api.stripe.com/v1/checkout/sessions");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"),`360kids-${bookingId}-2`);
    const body=new URLSearchParams(init?.body as string);
    assert.equal(body.get("line_items[0][price_data][currency]"),"aed");
    assert.equal(body.get("line_items[0][price_data][unit_amount]"),"25000");
    assert.equal(body.get("client_reference_id"),bookingId);
    assert.equal(body.get("allowed_payment_method_types[0]"),"card");
    assert.equal(body.has("payment_method_types[0]"),false);
    assert.equal(body.toString().includes("child"),false);
    return Response.json(session);
  };
  const checkout=await createStripeTestCheckout({id:bookingId,version:2,amountFils:25000,paymentDueAt:new Date(Date.now()+3600000).toISOString(),title:"Synthetic activity"},env,request);
  assert.deepEqual(checkout,{id:session.id,url:session.url});
  assert.equal(calls,1);
  await assert.rejects(()=>createStripeTestCheckout({id:bookingId,version:2,amountFils:25000,paymentDueAt:new Date(Date.now()+120000).toISOString(),title:"Synthetic activity"},env,request),/30 minutes/);
  assert.equal(calls,1);
});

test("only server-retrieved paid test sessions matching booking and amount verify", async () => {
  const booking={id:bookingId,amountFils:25000};
  const request:typeof fetch=async (_url,init) => {
    assert.equal(init?.method,"GET");
    return Response.json({...session,status:"complete",payment_status:"paid"});
  };
  assert.equal(await verifyStripeTestCheckout(session.id,booking,env,request),true);
  assert.equal(await verifyStripeTestCheckout(session.id,{...booking,amountFils:25001},env,request),false);
  assert.equal(await verifyStripeTestCheckout(session.id,booking,env,async()=>Response.json({...session,status:"complete",payment_status:"paid",livemode:true})),false);
  await assert.rejects(()=>verifyStripeTestCheckout("cs_live_synthetic",booking,env,request),/Invalid Stripe test/);
});
