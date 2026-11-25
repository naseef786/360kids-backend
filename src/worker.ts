import "dotenv/config";
import { database } from "./database.js";
import { Platform } from "./platform.js";
import { dispatchContactEmails } from "./contact-mail.js";
import { dispatchContactAcknowledgments } from "./contact-ack.js";
import { StripeCheckout } from "./stripe-checkout.js";
const db = database();
const service = new Platform(db);
const stripeCheckout = new StripeCheckout(db);
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;
async function run() {
  try {
    if (!(await service.ready())) throw new Error("Schema is not ready");
    try { await stripeCheckout.reconcileOpen(); }
    catch { console.error("Stripe test reconciliation sweep failed."); }
    await service.expire();
    await service.remind();
    await dispatchContactEmails(db);
    await dispatchContactAcknowledgments(db);
  } catch {
    console.error("Background sweep failed; check database and email configuration.");
  } finally {
    if (!stopped) timer = setTimeout(start, 30000);
  }
}
function start() { active = run(); }
async function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  try {
    await active;
    await db.end?.();
  } finally { clearTimeout(deadline); }
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
start();
