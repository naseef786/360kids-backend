import test from "node:test";
import assert from "node:assert/strict";
import { checkMessageEligibility, type ContactPermission } from "../src/integrations/whatsapp/eligibility.js";
const unknown: ContactPermission = { suppressed: false, bookingUpdates: "unknown", marketing: "unknown" };
test("unverified imports are ineligible for either purpose", () => {
  for (const purpose of ["booking_update", "marketing"] as const) {
    assert.deepEqual(checkMessageEligibility(unknown, purpose), { eligible: false, reason: "permission_not_verified" });
  }
});
test("booking permission cannot authorize marketing", () => {
  const contact = { ...unknown, bookingUpdates: "verified" as const };
  assert.equal(checkMessageEligibility(contact, "booking_update").eligible, true);
  assert.equal(checkMessageEligibility(contact, "marketing").eligible, false);
});
test("suppression overrides previous verified permissions", () => {
  const contact: ContactPermission = { suppressed: true, bookingUpdates: "verified", marketing: "verified" };
  for (const purpose of ["booking_update", "marketing"] as const) {
    assert.deepEqual(checkMessageEligibility(contact, purpose), { eligible: false, reason: "suppressed" });
  }
});
test("revoked permission is ineligible", () => {
  assert.equal(checkMessageEligibility({ ...unknown, marketing: "revoked" }, "marketing").eligible, false);
});
