import test from "node:test";
import assert from "node:assert/strict";
import { ageOnDate, possibleAges, dubaiDate } from "../src/eligibility.js";

test("Dubai calendar dates cross midnight before UTC dates", () => {
  assert.equal(dubaiDate(new Date("2026-11-07T20:30:00Z")), "2026-11-08");
  assert.equal(
    ageOnDate(
      new Date("2020-11-08"),
      new Date(dubaiDate(new Date("2026-11-07T20:30:00Z"))),
    ),
    6,
  );
});

test("exact ages use session date and birthday boundaries", () => {
  const dob = new Date("2020-11-10");
  assert.equal(ageOnDate(dob, new Date("2026-11-09")), 5);
  assert.equal(ageOnDate(dob, new Date("2026-11-10")), 6);
});
test("age-only profiles retain uncertainty instead of inventing a birthday", () => {
  assert.deepEqual(
    possibleAges(6, new Date("2026-11-08"), new Date("2026-11-08")),
    [6, 6],
  );
  assert.deepEqual(
    possibleAges(6, new Date("2026-11-08"), new Date("2026-11-15")),
    [6, 7],
  );
  assert.deepEqual(
    possibleAges(6, new Date("2026-11-08"), new Date("2028-11-08")),
    [8, 8],
  );
});
test("age intervals clamp leap-day anniversaries without drifting a month", () => {
  assert.deepEqual(
    possibleAges(1, new Date("2028-02-29"), new Date("2028-02-29")),
    [1, 1],
  );
  assert.deepEqual(
    possibleAges(1, new Date("2028-02-29"), new Date("2028-03-01")),
    [1, 2],
  );
});
