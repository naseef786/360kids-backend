/** Stripe test-mode transport only. This module never changes booking or payment state. */
export function stripeTestConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.STRIPE_TEST_ENABLED !== "true") return { enabled: false } as const;
  if (env.APP_ENV !== "staging") throw new Error("Stripe test checkout requires the staging environment.");
  const key = env.STRIPE_TEST_SECRET_KEY;
  const ref = env.STRIPE_TEST_PROJECT_REF;
  if (!key || !/^(sk_test_|rk_test_)[A-Za-z0-9_]+$/.test(key) || !ref || !/^[a-z0-9]{10,30}$/.test(ref))
    throw new Error("Stripe test checkout requires a test secret key and staging project ref.");
  let auth: URL, database: URL, web: URL;
  try {
    auth = new URL(env.SUPABASE_URL ?? "");
    database = new URL(env.DATABASE_URL ?? "");
    web = new URL(env.WEB_ORIGIN ?? "");
  } catch { throw new Error("Stripe test checkout target URLs are not configured."); }
  const pooler = database.hostname.endsWith(".pooler.supabase.com") &&
    decodeURIComponent(database.username) === `postgres.${ref}`;
  const direct = database.hostname === `db.${ref}.supabase.co`;
  if (auth.protocol !== "https:" || auth.hostname !== `${ref}.supabase.co` ||
      !["postgres:","postgresql:"].includes(database.protocol) || (!pooler && !direct))
    throw new Error("Stripe test Auth and database projects do not match the staging ref.");
  if (web.protocol !== "https:" && !(web.protocol === "http:" && ["localhost","127.0.0.1"].includes(web.hostname)))
    throw new Error("Stripe test website origin must use HTTPS outside loopback.");
  return { enabled: true, key, webOrigin: web.origin } as const;
}

type CheckoutSession = {
  id: string;
  url?: string | null;
  livemode: boolean;
  client_reference_id: string | null;
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  status: string | null;
  metadata: Record<string,string>;
};

async function stripeRequest(path: string, key: string, init: RequestInit, request: typeof fetch): Promise<CheckoutSession> {
  let response: Response;
  try {
    response = await request(`https://api.stripe.com/v1/checkout/sessions${path}`,{
      ...init,
      headers: {Authorization:`Bearer ${key}`,...init.headers},
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error("Stripe test service is unavailable."); }
  if (!response.ok) throw new Error("Stripe test service rejected the request.");
  try { return await response.json() as CheckoutSession; }
  catch { throw new Error("Stripe test service returned an invalid response."); }
}

export async function createStripeTestCheckout(
  booking: {id:string;version:number;amountFils:number;paymentDueAt:string;title:string},
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const config = stripeTestConfig(env);
  if (!config.enabled) throw new Error("Stripe test checkout is disabled.");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(booking.id) ||
      !Number.isInteger(booking.version) || booking.version < 1 ||
      !Number.isSafeInteger(booking.amountFils) || booking.amountFils < 1 || booking.amountFils > 100000000)
    throw new Error("Invalid booking checkout parameters.");
  const secondsRemaining = Math.floor((Date.parse(booking.paymentDueAt)-Date.now())/1000);
  if (!Number.isFinite(secondsRemaining) || secondsRemaining < 1800)
    throw new Error("Less than 30 minutes remain; Stripe Checkout cannot fit the booking deadline.");
  const expiresAt = Math.floor(Date.now()/1000) + Math.min(secondsRemaining,86400);
  const returnPath = `/parent/bookings/${booking.id}`;
  const body = new URLSearchParams({
    mode:"payment",
    success_url:`${config.webOrigin}${returnPath}?stripe_session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:`${config.webOrigin}${returnPath}?stripe_cancelled=1`,
    client_reference_id:booking.id,
    "metadata[booking_id]":booking.id,
    "metadata[booking_version]":String(booking.version),
    "line_items[0][price_data][currency]":"aed",
    "line_items[0][price_data][unit_amount]":String(booking.amountFils),
    "line_items[0][price_data][product_data][name]":booking.title.slice(0,120),
    "line_items[0][quantity]":"1",
    "allowed_payment_method_types[0]":"card",
    expires_at:String(expiresAt),
  });
  const session = await stripeRequest("",config.key,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":`360kids-${booking.id}-${booking.version}`},
    body,
  },request);
  if (session.livemode || !session.id.startsWith("cs_test_") || session.client_reference_id !== booking.id ||
      !session.url || new URL(session.url).hostname !== "checkout.stripe.com")
    throw new Error("Stripe returned an unsafe test checkout session.");
  return {id:session.id,url:session.url};
}

/** A return URL is never proof of payment; only a server-retrieved, matched session qualifies. */
export async function verifyStripeTestCheckout(
  sessionId: string,
  booking: {id:string;amountFils:number},
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const config = stripeTestConfig(env);
  if (!config.enabled) throw new Error("Stripe test checkout is disabled.");
  if (!/^cs_test_[a-zA-Z0-9_]{6,66}$/.test(sessionId)) throw new Error("Invalid Stripe test session ID.");
  const session = await stripeRequest(`/${encodeURIComponent(sessionId)}`,config.key,{method:"GET"},request);
  return session.id === sessionId && session.livemode === false && session.status === "complete" &&
    session.payment_status === "paid" && session.currency === "aed" &&
    session.amount_total === booking.amountFils && session.client_reference_id === booking.id &&
    session.metadata?.booking_id === booking.id;
}
