// Birth dates and declared ages are calendar dates in the activity market's timezone.
export function dubaiDate(value: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
export function ageOnDate(birth: Date, on: Date): number {
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  if (
    on.getUTCMonth() < birth.getUTCMonth() ||
    (on.getUTCMonth() === birth.getUTCMonth() &&
      on.getUTCDate() < birth.getUTCDate())
  )
    age--;
  return age;
}

function subtractYears(date: Date, years: number) {
  const year = date.getUTCFullYear() - years;
  const month = date.getUTCMonth();
  const day = Math.min(
    date.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  );
  return new Date(Date.UTC(year, month, day));
}

// A declared integer age is a DOB interval, not an invented exact birthday.
export function possibleAges(age: number, recordedOn: Date, sessionOn: Date) {
  const youngestBirthDate = subtractYears(recordedOn, age);
  const oldestBirthDate = subtractYears(recordedOn, age + 1);
  oldestBirthDate.setUTCDate(oldestBirthDate.getUTCDate() + 1);
  return [
    ageOnDate(youngestBirthDate, sessionOn),
    ageOnDate(oldestBirthDate, sessionOn),
  ] as const;
}
