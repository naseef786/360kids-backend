import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { connectionOptions } from "../src/database.js";
import { Platform } from "../src/platform.js";
if (
  process.env.NODE_ENV === "production" ||
  !process.argv.includes("--development-only")
)
  throw new Error(
    "Use --development-only with an isolated development project.",
  );
const url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key)
  throw new Error("Development Auth administration is not configured.");
const pool = new pg.Pool(connectionOptions()),
  platform = new Platform(pool);
const accounts: Record<
  string,
  { id: string; email: string; password: string }
> = {};
try {
  const suffix = randomBytes(5).toString("hex");
  for (const role of ["parent", "partner", "admin", "outsider"]) {
    const email = `dev-${role}-${suffix}@example.invalid`,
      password = randomBytes(24).toString("base64url") + "!9aA";
    const response = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { synthetic: true },
      }),
    });
    if (!response.ok)
      throw new Error(
        `Synthetic account creation failed (${response.status}).`,
      );
    const result = await response.json();
    const id = result.id ?? result.user?.id;
    if (typeof id !== "string")
      throw new Error("Synthetic account response was invalid.");
    await platform.me(id, email);
    if (role === "admin") {
      await pool.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [
        id,
      ]);
      await platform.audit(
        { query: (sql, params) => pool.query(sql, params), release() {} },
        { id, role: "admin" },
        id,
        "development.synthetic_admin_created",
      );
    }
    accounts[role] = { id, email, password };
  }
  await writeFile(
    new URL("../.e2e-accounts.json", import.meta.url),
    JSON.stringify({ runId: randomUUID(), accounts }, null, 2),
  );
  console.log(
    "Four fictional development accounts prepared. Credentials are stored in an ignored local file; no emails were sent.",
  );
} catch {
  console.error(
    "Unable to prepare all synthetic accounts. No credentials have been printed.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
