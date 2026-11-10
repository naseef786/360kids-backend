# 360 Kids Backend

Express, TypeScript and PostgreSQL business API for the Next.js website and Expo app. Uses Supabase Auth for identity verification. Database records live in a private `app` schema, accessed by the server connection only.

## Setup (PowerShell)

Node.js 24.22.2:

```powershell
npm ci
Copy-Item .env.example .env
# Set DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.
npm run db:migrate
npm run dev
```

Run migrations only against the intended development database first. Use a server database connection with permission to create/access the private schema. Never expose this schema through Supabase's public Data API. Keep the database URL and privileged credentials server-side. Use the provider's documented TLS connection settings; do not disable certificate verification.

Supabase database hosts use the bundled public CA in `certificates/supabase-ca.crt`, with certificate-chain and hostname verification enabled. Set `DATABASE_CA_CERT` to an alternate trusted CA file if required by your database host. Remote connections reject weak TLS settings. Use the session-pooler connection when the local network cannot reach the direct database's IPv6 address.

Sign in once through a configured client to create the application profile. An authorized database operator must assign the initial admin role in `app.profiles`; there is no public role-elevation endpoint. `/v1/me` returns canonical `roles` (`parent`, `partner`, `superadmin`); fetch organizations using paginated `/v1/providers`. The legacy `role` field (`parent`, `provider`, `admin`) remains for compatibility. An account can be both a parent and partner staff member.

Approved organizations have an owner and may have existing-account staff memberships. Only the owner or a platform admin may manage staff; staff cannot grant access or change the owner. Membership revocation and provider suspension are checked on reads, actions and action retries. Staff can review/respond to their organization's booking requests; this does not grant finance verification or platform administration. Branch-specific roles and a full capability matrix remain outstanding.

Start the expiry sweep in a separate supervised process:

```powershell
npm run worker
```

The worker releases overdue unpaid holds. It does not expire timely payment submissions awaiting verification. Pending requests/offers need the final response-expiry policy; email/WhatsApp delivery is not implemented. Outbox events are durably recorded for that work.

## Checks

```powershell
npm run typecheck
npm test
npm run build
npm start
```

The integration test executes real PostgreSQL SQL using embedded PGlite. It tests the lifecycle, scoped data access, allocation exhaustion, idempotency, API authentication/authorization and suppression preservation. It does not prove multi-connection locking behavior on hosted PostgreSQL. Run dedicated concurrent-session tests on staging before launch.

## API

Public: `GET /health/live`, `GET /health/ready`, `GET /v1/status`, `GET /v1/activities`, `GET /v1/activities/:id`. Readiness checks database schema access and auth configuration, not a live Supabase sign-in round trip.

Authenticated: `GET /v1/me`; `GET/POST /v1/children`; `PUT /v1/children/:id`; `GET/POST /v1/bookings`; `GET /v1/bookings/:id`; `POST /v1/bookings/:id/actions`; `GET/POST /v1/providers`.

Owner/admin: `GET/POST /v1/providers/:id/members`. New staff members must already have an active application profile; no invitation email is sent. Non-approved provider review decisions require a reason.

Child creation/update requires a preferred `firstName` and exactly one of `ageYears` or `birthDate`; `surname` is optional. An age-only profile stores its declaration date, never a fabricated birthday. Requests require an exact birth date when the possible age range crosses an activity's eligibility boundary. `PUT` replaces the editable child profile and only permits its parent owner.

All growing list endpoints use `{items,total,page,pageSize,pages}`, with `page` (default 1) and `pageSize` (default 20, maximum 100). Catalogue filters: `q`, `age`, `area`, `category`. Search is literal and case-insensitive; unpublished activities and suspended providers never appear. See [the API contract](docs/API_CONTRACT.md).

Provider/admin: booking accept/decline/offer; providers may submit `POST /v1/activities/:id/corrections` for their own activities.

Partners can submit draft activities; only admins may publish, edit catalogue content or add sessions. All growing lists, including activity sessions, are independently paginated.

Admin: `POST /v1/providers/:id/review`; `POST /v1/activities`; `GET /v1/admin/operations` (counts/flags), `GET /v1/admin/lists/:resource`; `POST /v1/admin/contacts/import`; `POST /v1/admin/contacts/:id/suppress`; `POST /v1/admin/campaigns`; `POST /v1/admin/refunds/:id/complete`.

Pass the Supabase access token as `Authorization: Bearer …`. Identity is checked with Supabase; active status and role are loaded from the database for each request. Booking commands require an `Idempotency-Key` and actions require the displayed booking version. Prices and permissions are checked server-side. No test-token bypass exists in the server.

## Finance and WhatsApp

`FINANCE_WORKFLOW_ENABLED=false` is the default. The source currently supports admin verification of a submitted transfer reference only after finance operation is explicitly configured. This is not a selected or approved collection arrangement. Provider receipt uploads, gateway settlement/webhooks, collector-specific permissions and complete policy-based cancellations remain to implement.

WhatsApp contact import currently accepts bounded JSON batches (32 KB request limit, up to 1,000 rows). Only explicit E.164 numbers are accepted. Imports create unknown permissions; duplicates preserve previous opt-outs. Campaigns are drafts only. Large CSV/Excel streaming, consent-evidence review, official sender transport, signed webhooks, scheduling and reporting remain outstanding. No external message is sent by these endpoints.

See `docs/IMPLEMENTATION_STATUS.md` for remaining work. Never commit contacts, child details, credentials, receipts or client documents. Environment templates contain placeholders only.
