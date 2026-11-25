export function assertMigrationTarget(env: NodeJS.ProcessEnv): void {
  const target = env.MIGRATION_TARGET;
  if (target !== "development" && target !== "staging" && target !== "production") {
    throw new Error("Set MIGRATION_TARGET to development, staging, or production before running migrations.");
  }
  if (target === "production" && env.MIGRATION_PRODUCTION_CONFIRM !== "APPLY_TO_PRODUCTION") {
    throw new Error("Production migrations require MIGRATION_PRODUCTION_CONFIRM=APPLY_TO_PRODUCTION after rehearsal and backup review.");
  }
}
