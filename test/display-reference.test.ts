import test from "node:test";
import assert from "node:assert/strict";
import { displayReference } from "../src/display-reference.js";

test("human references are short and distinguish contact from booking", () => {
  const id = "12345678-90ab-4cde-8f12-34567890abcd";
  assert.equal(displayReference("contact", id), "CT-1234567890AB4CDE");
  assert.equal(displayReference("booking", id), "BK-1234567890AB4CDE");
  assert.equal(id.length, 36);
});
