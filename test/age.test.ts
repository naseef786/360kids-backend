import test from "node:test";
import assert from "node:assert/strict";
import { ageAtSession, dubaiCalendarDate } from "../src/age.js";
test("eligibility uses the Dubai activity date across UTC midnight", () => {
  assert.equal(ageAtSession("2018-05-02", "2030-05-01T21:30:00Z"), 12);
  assert.equal(ageAtSession("2018-05-02", "2030-05-01T19:30:00Z"), 11);
  assert.equal(dubaiCalendarDate("2030-05-01T21:30:00Z"), "2030-05-02");
});
