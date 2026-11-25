/** Human-facing reference only. Full UUIDs remain authoritative for API actions and audit. */
export function displayReference(kind: "contact" | "booking", id: string): string {
  const compact = id.replaceAll("-", "").slice(0, 16).toUpperCase();
  return `${kind === "contact" ? "CT" : "BK"}-${compact}`;
}
