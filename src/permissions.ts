import type { Connection } from "./database.js";

export type Capability =
  | "bookings.read"
  | "bookings.override"
  | "payments.read"
  | "payments.verify"
  | "refunds.complete"
  | "support.manage"
  | "content.manage";

export async function requireCapability(c: Connection, userId: string, capability: Capability) {
  const { rows } = await c.query("SELECT app.has_capability($1,$2) AS allowed", [
    userId, capability,
  ]);
  if (!rows[0]?.allowed)
    throw Object.assign(new Error(`Capability required: ${capability}.`), { status: 403 });
}

export function requireStepUp(actor: { assuranceLevel?: string }) {
  if (actor.assuranceLevel !== "aal2")
    throw Object.assign(new Error("Step-up authentication required."), { status: 403 });
}
