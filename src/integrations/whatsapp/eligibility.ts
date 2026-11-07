/** Preliminary permission gate, not a transport or a complete sending authorization. */
export type MessagePurpose = "booking_update" | "marketing";
export type ConsentState = "verified" | "unknown" | "revoked";
export interface ContactPermission {
  suppressed: boolean;
  bookingUpdates: ConsentState;
  marketing: ConsentState;
}
export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: "suppressed" | "permission_not_verified" };
export function checkMessageEligibility(
  contact: ContactPermission,
  purpose: MessagePurpose,
): Eligibility {
  if (contact.suppressed) return { eligible: false, reason: "suppressed" };
  const state =
    purpose === "booking_update" ? contact.bookingUpdates : contact.marketing;
  if (state !== "verified")
    return { eligible: false, reason: "permission_not_verified" };
  return { eligible: true };
}
// No send API exists. Dispatch must additionally enforce sender ownership, approved
// templates/window, contact validation, policy freshness, dedupe and account limits.
