import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createApp } from "../src/app.js";
test("API starter reports its limits and handles invalid requests", async () => {
  const server = createApp("http://localhost:3000").listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${origin}/health/live`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-powered-by"), null);
    assert.equal((await health.json()).status, "ok");
    const ready = await fetch(`${origin}/health/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).database, false);
    const status = await fetch(`${origin}/v1/status`);
    assert.deepEqual(await status.json(), {
      version: "0.1.0",
      stage: "development",
      bookingsAvailable: false,
      financeEnabled: false,
      whatsappSendingAvailable: false,
      financeWorkflowEnabled: false,
    });
    const readiness = await fetch(`${origin}/health/ready`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).status, "not_ready");
    const missing = await fetch(`${origin}/v1/bookings`);
    assert.equal(missing.status, 503);
    const bad = await fetch(`${origin}/v1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), {
      code: "INVALID_REQUEST",
      message: "Invalid request body.",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
