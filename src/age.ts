/** Calendar date in Dubai, independent of the API server's timezone. */
export function dubaiCalendarDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
/** Eligibility on the Dubai session date. Read PostgreSQL birth dates as calendar strings. */
export function ageAtSession(
  birthDate: string | Date,
  startsAt: string | Date,
): number {
  const dob = new Date(birthDate);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(startsAt));
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  let age = part("year") - dob.getUTCFullYear();
  if (
    part("month") < dob.getUTCMonth() + 1 ||
    (part("month") === dob.getUTCMonth() + 1 && part("day") < dob.getUTCDate())
  )
    age--;
  return age;
}
