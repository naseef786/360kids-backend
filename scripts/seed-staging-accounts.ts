import "dotenv/config";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { connectionOptions } from "../src/database.js";
import { Platform } from "../src/platform.js";
import { assertSyntheticTarget } from "../src/synthetic-target.js";

if (
  process.env.NODE_ENV === "production" ||
  !process.argv.includes("--development-only")
) {
  throw new Error(
    "Use --development-only with an isolated development/staging project.",
  );
}
assertSyntheticTarget(process.env);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  throw new Error("Supabase Auth administration is not configured.");
}

const pool = new pg.Pool(connectionOptions());
const platform = new Platform(pool);

async function createAuthUser(email: string, password: string) {
  const response = await fetch(`${url!.replace(/\/$/, "")}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { synthetic: true },
    }),
  });
  if (!response.ok) {
    throw new Error(`Account creation failed (${response.status}).`);
  }
  const result = (await response.json()) as { id?: string; user?: { id?: string } };
  const id = result.id ?? result.user?.id;
  if (typeof id !== "string") {
    throw new Error("Account response was invalid.");
  }
  await platform.me(id, email);
  return { id, email, password };
}

try {
  const suffix = randomBytes(4).toString("hex");
  const admin = await createAuthUser(
    `staging-admin-${suffix}@example.invalid`,
    randomBytes(18).toString("base64url") + "!9aA",
  );
  await pool.query("UPDATE app.profiles SET role='admin' WHERE id=$1", [admin.id]);
  await pool.query(
    `INSERT INTO app.platform_role_grants(user_id,role,granted_by,reason)
     SELECT $1,role,$1,'Staging testing seed operator'
     FROM (VALUES ('content'),('support'),('finance')) AS g(role)
     ON CONFLICT DO NOTHING`,
    [admin.id],
  );
  const adminActor = await platform.me(admin.id, admin.email);

  const partners = [];
  for (let i = 1; i <= 2; i++) {
    const account = await createAuthUser(
      `staging-partner${i}-${suffix}@example.invalid`,
      randomBytes(18).toString("base64url") + "!9aA",
    );
    const partnerActor = await platform.me(account.id, account.email);
    const org = await platform.apply(partnerActor, {
      name: `Staging Partner ${i} Academy (${suffix})`,
      description: `Synthetic staging provider organization ${i} for testing.`,
    });
    await platform.approve(adminActor, org.id, "approved");
    const startsAt = new Date(Date.now() + (7 + i) * 86400000).toISOString();
    const cutoffAt = new Date(Date.now() + (6 + i) * 86400000).toISOString();
    const activity = await platform.createActivity(adminActor, {
      providerId: org.id,
      title: `Staging ${i === 1 ? "Robotics" : "Swimming"} Club (${suffix})`,
      description: "Synthetic staging activity created for manual QA testing.",
      category: i === 1 ? "Learning" : "Sports",
      area: i === 1 ? "Dubai Marina" : "Jumeirah",
      minAge: 4,
      maxAge: 14,
      priceFils: i === 1 ? 15000 : 12000,
      policy: "Full refund up to 48 hours before session start.",
      published: true,
      startsAt,
      cutoffAt,
      capacity: 10,
    });
    partners.push({ ...account, organizationId: org.id, activityId: activity.id });
  }

  const parents = [];
  for (let i = 1; i <= 2; i++) {
    const account = await createAuthUser(
      `staging-parent${i}-${suffix}@example.invalid`,
      randomBytes(18).toString("base64url") + "!9aA",
    );
    const parentActor = await platform.me(account.id, account.email);
    const child1 = await platform.addChild(parentActor, {
      firstName: i === 1 ? "Zayd" : "Maya",
      surname: `TestFamily${i}`,
      birthDate: "2018-05-10",
    });
    const child2 = await platform.addChild(parentActor, {
      firstName: i === 1 ? "Lina" : "Omar",
      surname: `TestFamily${i}`,
      ageYears: 10,
    });
    parents.push({ ...account, children: [child1.id, child2.id] });
  }

  await writeFile(
    new URL("../.e2e-accounts.json", import.meta.url),
    JSON.stringify({ runId: suffix, admin, partners, parents }, null, 2),
  );
  console.log(
    "Staging test accounts, organizations, published activities, and children saved to 360kids-backend/.e2e-accounts.json.",
  );
} finally {
  await pool.end();
}
