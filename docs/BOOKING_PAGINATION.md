# Booking pagination — 10 November 2026

## Result

The family, provider and admin booking lists now use server-side status filtering, literal text search and cursor pagination. Parents can find older records without the former 200-record UI limit. Dashboard counts cover all bookings authorized in the current workspace. Overview panels show up to 25 latest records and link to the full list; provider/admin overviews show only requests needing attention.

## API contract

`GET /v1/bookings/page` requires authentication. Query parameters:

| Parameter | Behavior |
| --- | --- |
| `scope` | `family`, `provider` or `all`; existing role/ownership rules remain authoritative. |
| `state` | `all`, `attention` or an existing booking state. Attention includes requested, offer pending, payment due and payment checking. |
| `search` | Trimmed text, up to 100 characters. Searches the accepted activity title, provider name or booking reference; `%`, `_` and backslashes are literal. No child names or dates of birth are searched. |
| `limit` | Integer 1–100, default 25. The website uses 25. |
| `cursor` | Opaque next-page cursor from the same scope/state/search; changed filters require starting again. |

The response is `{ items, total, counts, nextCursor }`. `total` counts all matching authorized records; `counts` covers the full authorized workspace, independent of the selected filter. Both are computed in the same SQL statement as the page. Pages sort by creation time descending, then ID descending. Cursor timestamps preserve PostgreSQL microseconds. Each request rechecks the current identity/role and SQL ownership; possession of a cursor grants no access.

This is a live list, not an export snapshot. New records appear when refreshed. State/search membership may change between requests; realtime refresh and successful booking actions restart pagination while keeping active filters. The UI cancels obsolete requests, ignores stale responses, deduplicates overlapping IDs and offers retry for initial/append errors.

The legacy `GET /v1/bookings` array remains available with its existing 200-record cap for compatibility. New clients use the page endpoint. Deploy the backend before the matching frontend. No new database migration is introduced; the four existing migrations are still required.

## Verification and limits

- Backend: 15 passing tests plus TypeScript/production compilation. New regressions use more than 300 synthetic records and cover pagination beyond 200, equal/microsecond timestamp boundaries, insertion between pages, scoped totals, search escaping, filters, cursor validation, signed-in role revocation and private HTTP responses.
- Web: 12 passing tests plus lint, TypeScript and production build. New tests cover query encoding and overlapping-page reconciliation without mutating previous records.
- No new dependencies are added to the application. Formatting uses a temporary tool only.
- No hosted Supabase migration, deployment, interactive browser/device QA or load benchmark was performed. Validate the mobile filter layout, keyboard use, slow connections, realtime refresh during pagination and large-dataset query plans on staging. Payments, WhatsApp and the native app scope are unchanged.
