import { z } from "zod";
export const bookingPageQuery = z.object({
  scope: z.enum(["all", "family", "provider"]).default("all"),
  state: z
    .enum([
      "all",
      "attention",
      "REQUESTED",
      "OFFER_PENDING",
      "PAYMENT_DUE",
      "PAYMENT_CHECKING",
      "CONFIRMED",
      "DECLINED",
      "EXPIRED",
      "CANCELLED",
    ])
    .default("all"),
  search: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1200).optional(),
});
export type BookingPageQuery = z.infer<typeof bookingPageQuery>;
const cursorSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    id: z.string().uuid(),
    scope: bookingPageQuery.shape.scope,
    state: bookingPageQuery.shape.state,
    search: bookingPageQuery.shape.search,
  })
  .strict();
export function readBookingCursor(query: BookingPageQuery) {
  if (!query.cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
    const bytes = Buffer.from(query.cursor, "base64url");
    if (bytes.toString("base64url") !== query.cursor) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (Number(cursor.createdAt.slice(0, 4)) < 1) throw new Error();
    if (
      cursor.scope !== query.scope ||
      cursor.state !== query.state ||
      cursor.search !== query.search
    )
      throw new Error();
    return cursor;
  } catch {
    throw Object.assign(
      new Error("Invalid booking page. Start again with the current filters."),
      { status: 422 },
    );
  }
}
export function nextBookingCursor(
  query: BookingPageQuery,
  row: { id: string; created_at: string },
) {
  return Buffer.from(
    JSON.stringify({
      createdAt: row.created_at,
      id: row.id,
      scope: query.scope,
      state: query.state,
      search: query.search,
    }),
  ).toString("base64url");
}
