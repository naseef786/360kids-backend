// Guard the operator-only fixture script before it makes any Auth or SQL writes.
// The explicit project ref must be taken from the approved isolated dev project.
export function assertSyntheticTarget(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production" || env.SYNTHETIC_TEST_TARGET !== "development") {
    throw new Error("Synthetic fixtures require an explicit development target.");
  }
  const expected = env.SYNTHETIC_TEST_PROJECT_REF;
  if (!expected || !/^[a-z0-9]{10,30}$/.test(expected)) {
    throw new Error("Set SYNTHETIC_TEST_PROJECT_REF to the isolated development project ref.");
  }
  let auth: URL;
  let database: URL;
  try {
    auth = new URL(env.SUPABASE_URL ?? "");
    database = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("Synthetic fixture Auth and database targets are not configured.");
  }
  const authMatches = auth.protocol === "https:" && auth.hostname === `${expected}.supabase.co`;
  const directMatches = database.hostname === `db.${expected}.supabase.co`;
  const poolerMatches = database.hostname.endsWith(".pooler.supabase.com") &&
    decodeURIComponent(database.username) === `postgres.${expected}`;
  if (!authMatches || !["postgres:", "postgresql:"].includes(database.protocol) ||
      (!directMatches && !poolerMatches)) {
    throw new Error("Synthetic fixture Auth/database targets do not match the approved development project ref.");
  }
}
