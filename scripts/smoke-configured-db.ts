import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { database } from "../src/database.js";
import { Platform } from "../src/platform.js";

// Loopback-only GET checks. Never submit mutations or print private data.
const db = database();
const app = createApp("http://127.0.0.1:3000", new Platform(db, false));
const server = createServer(app);
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port.");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const path of ["/health/live", "/health/ready", "/v1/status", "/v1/activities?page=1&pageSize=2"]) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10000) });
    console.log(`${path.split("?")[0]}: HTTP ${response.status}`);
    if (!response.ok) {
      process.exitCode = 1;
      continue;
    }
    const body = await response.json() as Record<string, unknown>;
    if (path === "/health/ready" && body.status !== "ready") process.exitCode = 1;
    if (path === "/v1/status" && body.bookingsAvailable !== true) process.exitCode = 1;
    if (path.startsWith("/v1/activities") &&
      (!Array.isArray(body.items) || typeof body.total !== "number" || body.page !== 1)) process.exitCode = 1;
    if (path.startsWith("/v1/activities") && Array.isArray(body.items))
      console.log(`Public catalogue sample: ${body.items.map((item) => String((item as {title?: unknown}).title ?? "untitled")).join(" | ")}`);
  }
  const connection = await db.connect();
  try {
    await connection.query("BEGIN READ ONLY");
    const grants = (await connection.query(`
      SELECT
        (SELECT count(*)::int FROM app.profiles WHERE role='admin' AND active) AS legacy_admins,
        (SELECT count(*)::int FROM app.platform_role_grants WHERE active) AS active_platform_grants
    `)).rows[0];
    console.log(`Active legacy admins=${grants.legacy_admins}; explicit platform grants=${grants.active_platform_grants}`);
    await connection.query("COMMIT");
  } catch {
    try { await connection.query("ROLLBACK"); } catch { /* preserve failure */ }
    throw new Error("Operator grant preflight failed.");
  } finally {
    connection.release();
  }
} catch {
  console.error("Configured database HTTP smoke failed.");
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.end?.();
}
