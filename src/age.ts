/** Age on the activity's Dubai calendar date, including sessions near UTC midnight. */
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
