import type { Platform, Actor } from "../../src/platform.js";

// Explicit synthetic fixture grants. Production migrations never grant these.
export async function grantFixtureRoles(p: Platform, actor: Actor) {
  actor.assuranceLevel = "aal2";
  if (actor.role === "admin") await p.read(`INSERT INTO app.platform_role_grants(user_id,role,granted_by,reason)
    SELECT $1,role,$1,'Synthetic test operator' FROM (VALUES ('finance'),('content'),('support')) r(role)
    ON CONFLICT DO NOTHING`,[actor.id]);
}

export async function grantFixtureBranchManager(p: Platform, providerId: string, userId: string) {
  await p.read(`INSERT INTO app.provider_branch_roles(provider_id,branch_id,user_id,role)
    VALUES($1,$1,$2,'branch_manager') ON CONFLICT DO NOTHING`,[providerId,userId]);
}
