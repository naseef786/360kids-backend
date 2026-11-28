# 360 Kids Backend

Current assessment: **development implementation, not production complete**. See [the architecture review](docs/ARCHITECTURE_REVIEW_2026-11-10.md) for corrected faults and remaining release gates. Apply all bundled migrations and deploy matching web/API versions; booking requests require `activityVersion`, and notifications use `page`/`pageSize`.

Express, TypeScript and PostgreSQL business API for the Next.js website and Expo app. Uses Supabase Auth for identity verification. Database records live in a private `app` schema, accessed by the server connection only.

## Setup (PowerShell)

Node.js 24.22.2:

```powershell
npm ci
Copy-Item .env.example .env
# Set DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.
$env:MIGRATION_TARGET = "development" # Only after checking DATABASE_URL is the intended dev database.
npm run db:migrate
npm run dev
```

Run migrations only against the intended development database first. The command requires `MIGRATION_TARGET=development|staging|production`; production also requires `MIGRATION_PRODUCTION_CONFIRM=APPLY_TO_PRODUCTION` after a staging rehearsal and backup/rollback review. These switches prevent accidental execution but do not verify the URL's actual environment: check the configured database project before running the command. Use a server database connection with permission to create/access the private schema. Never expose this schema through Supabase's public Data API. Keep the database URL and privileged credentials server-side. Use the provider's documented TLS connection settings; do not disable certificate verification.

Supabase database hosts use the bundled public CA in `certificates/supabase-ca.crt`, with certificate-chain and hostname verification enabled. Set `DATABASE_CA_CERT` to an alternate trusted CA file if required by your database host. Remote connections reject weak TLS settings. Use the session-pooler connection when the local network cannot reach the direct database's IPv6 address.

Sign in once through a configured client to create the application profile. An authorized database operator must assign the initial admin role in `app.profiles`; there is no public role-elevation endpoint. `/v1/me` returns canonical `roles` (`parent`, `partner`, `superadmin`); fetch organizations using paginated `/v1/providers`. The legacy `role` field (`parent`, `provider`, `admin`) remains for compatibility. An account can be both a parent and partner staff member.

Approved organizations have an owner and may have existing-account staff memberships. Only the approved provider owner may manage staff; changes require verified AAL2 authentication. Staff membership alone grants no private booking/listing access: explicit branch roles and, for booking staff, individual request assignments are required. Membership/branch revocation and provider suspension are checked on reads, actions, retries and notifications. Apply migration 006 with the matching API and provision explicit operator grants before rollout; existing admins receive no automatic finance, content or support capability. See [the permissions foundation](docs/PERMISSIONS_FOUNDATION.md).

Start the expiry sweep in a separate supervised process:

```powershell
npm run worker
```

The worker expires pending requests, held revised offers, unpaid bookings and unresolved payment reviews at their fixed deadlines. It also records one in-product/outbox reminder per eligible active window. Review expiry releases the hold but retains submitted payment evidence as an open finance exception; it never marks funds verified or refunded. The worker is still a single-process polling loop. Contact-form email dispatch is implemented separately with durable attempts and retries; booking outbox email and push delivery are not implemented.

## Stripe test checkout boundary

The owner has requested Stripe **test mode** for staging work while real finance activation is deferred. `src/stripe-test.ts` is a fail-closed transport foundation: it creates hosted AED Checkout Sessions using a server amount and stable idempotency key, and retrieves test sessions server-side to check paid status, amount, currency and booking identity. It rejects live keys, mismatched Supabase Auth/database project refs, non-staging configuration and payment windows shorter than Stripe's 30-minute minimum. No secret belongs in the web environment. Configure `APP_ENV=staging`, `STRIPE_TEST_ENABLED=true`, `STRIPE_TEST_PROJECT_REF` (the Supabase project ID, not a Stripe publishable key) and `STRIPE_TEST_SECRET_KEY` (an `sk_test_...` key or a least-privilege `rk_test_...` key with Checkout Session create/read permission) in the private backend environment only after booking reconciliation is connected and tested. The test key is now in the ignored backend `.env`; a read-only Stripe Checkout API request succeeded. The public `pk_test_...` key is not needed for a hosted Checkout redirect. A `rk_live_...` key was briefly placed in tracked `.env.example`; it was removed without use and should be rotated/revoked in Stripe.

Staging Checkout now has parent-scoped start/reconcile routes, a private durable attempt table, a parent button/return check, and worker polling before booking expiry. Confirmation requires server-retrieved matching paid test status while the original booking version, amount, hold and payment deadline remain valid. Late or changed paid sessions create an audited exception without confirming a place. Migration 011 was applied to the owner-designated staging connection on 21 November; the feature switch remains disabled pending a controlled authenticated browser journey. A synthetic test-mode Checkout Session was created and server retrieval correctly reported it as unpaid; no charge was made. There is no webhook, and worker polling is single-process; production activation is prohibited. Test-mode payment records are staging fixtures, not received production funds. The live collection/reconciliation and release rules in D07 remain open. Stripe's [Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create) and [retrieval API](https://docs.stripe.com/api/checkout/sessions/retrieve) are the transport references.

## Transactional email configuration

The mailbox details supplied by the owner are represented in `.env.example`: authenticated SMTP at `mail.360kidsactivity.com:465` with implicit TLS and `customerservice@360kidsactivity.com` as the sender and contact-notification recipient. IMAP/POP3 are for reading mail and are not needed by the application. The `src/email.ts` transport adapter is disabled by default. The supervised `npm run worker` process dispatches **new** contact enquiries only when `EMAIL_DELIVERY_MODE=smtp` and all SMTP settings including `EMAIL_SMTP_PASSWORD` are present in the backend's private environment. Existing enquiries from before migration 009 are `not_queued` and are not back-sent. Contact email delivery records leased attempts, retry times, terminal failure and SMTP acceptance; acceptance is not proof of inbox delivery. Keep the password server-side only, and do not commit or paste its value. This does not enable booking notifications: their outbox still needs leased delivery and templates. Run a controlled mailbox test before enabling customer mail.

New contact submissions also queue a separate, plain-text and HTML thank-you receipt. Both the internal contact notice and thank-you HTML now include the 360 Kids Activity logo as an inline PNG attachment, so they do not depend on remote image loading; plain-text clients retain readable fallback content. Existing messages in an inbox cannot be restyled retroactively. The receipt copy acknowledges receipt, gives a reference, and says a contact message is not a confirmed place. `CONTACT_ACK_ENABLED=false` is the default; the public form can otherwise be abused to send mail to arbitrary addresses. Do not enable public auto-replies in production until distributed abuse protection and recipient-rate limits are in place. When explicitly enabled alongside SMTP, the supervised worker records each receipt attempt and retries failures; it never changes the saved enquiry outcome. Existing submissions are not back-sent. Admin contact listings show both internal-notice and thank-you delivery status.

The durable delivery log is in private `app.contact_email_attempts` (service-inbox notice) and `app.contact_ack_attempts` (customer receipt), joined to `app.contact_submissions` and `app.contact_acknowledgments` respectively. Support-authorized staff see current status, attempt count and SMTP acceptance time in `/admin/contact-submissions`; individual attempt rows are database-operator-only. `accepted` means the SMTP server took the message, not that the destination inbox displayed it. The backend must run the supervised worker for automatic delivery; the website server alone only queues submissions.

Supabase Auth's sign-up, confirmation and recovery messages use a **separate** custom SMTP configuration in the Supabase Auth project, not `src/email.ts` or this API's environment. The account owner must verify confirmation/recovery end to end. On 20 November 2026, one synthetic contact enquiry was SMTP-accepted and a matching message was found in the configured mailbox's inbox over authenticated IMAP. This verifies a controlled contact-email path, not ongoing delivery: keep the supervised worker running in the deployment and monitor its attempt/status records. The private backend `.env` now holds the SMTP password; `.env.example` must remain credential-free.

## Checks

```powershell
npm run typecheck
npm test
npm run build
npm start
```

For a read-only configuration/connection/migration-ledger preflight, run
`npm run db:diagnose`. It reports only readiness categories and migration names,
not credentials or database records. A failed connection must be resolved before
considering migrations; do not run `db:migrate` against an unidentified database.
For a read-only count of existing business records before a schema change, run
`node --import tsx scripts/preflight-configured-db.ts`. For a loopback-only,
read-only API smoke against the configured database, run
`node --import tsx scripts/smoke-configured-db.ts`. Neither command creates
fixtures, bookings or payments; neither substitutes for a verified backup or
authenticated end-to-end test.

The integration test executes real PostgreSQL SQL using embedded PGlite. It tests the lifecycle, scoped data access, allocation exhaustion, idempotency, API authentication/authorization and suppression preservation. It does not prove multi-connection locking behavior on hosted PostgreSQL. Run dedicated concurrent-session tests on staging before launch.

## API

Public: `GET /health/live`, `GET /health/ready`, `GET /v1/status`, `GET /v1/activities`, `GET /v1/activities/:id`. Readiness checks database schema access and auth configuration, not a live Supabase sign-in round trip.

The public `POST /v1/contact` accepts a bounded name, email, topic and message, requires a UUID `Idempotency-Key`, uses a honeypot and a coarse 60-per-minute process-local flood guard, and stores submissions in the private `app.contact_submissions` table. The submission succeeds independently of SMTP. Authorized support operators can page/filter `GET /v1/admin/contact-submissions`, inspect email-notification status, and update the enquiry status with `PUT /v1/admin/contact-submissions/:id`; they reply manually using the submitted address. The web BFF shares an upstream IP, so the process-local guard is not a per-visitor limit or a substitute for distributed/edge abuse protection at release.

Authenticated: `GET /v1/me`; `GET/POST /v1/children`; `PUT /v1/children/:id`; `GET/POST /v1/bookings`; `GET /v1/bookings/:id`; `POST /v1/bookings/:id/actions`; `GET/POST /v1/providers`.

`POST /v1/bookings` fails closed unless Supabase Auth reports a confirmed email for the signed-in user. `GET /v1/me` exposes an `emailVerified` boolean for client guidance, never the verification timestamp. Phone/SMS verification is not required under the owner's latest direction.

Owner/admin: `GET/POST /v1/providers/:id/members`. New staff members must already have an active application profile; no invitation email is sent. Non-approved provider review decisions require a reason.

Child creation/update requires a preferred `firstName` and exactly one of `ageYears` or `birthDate`; `surname` is optional. An age-only profile stores its declaration date, never a fabricated birthday. Requests require an exact birth date when the possible age range crosses an activity's eligibility boundary. `PUT` replaces the editable child profile and only permits its parent owner.

All growing list endpoints use `{items,total,page,pageSize,pages}`, with `page` (default 1) and `pageSize` (default 20, maximum 100). Catalogue filters: `q`, `age`, `area`, `category`. Search is literal and case-insensitive; unpublished activities and suspended providers never appear. See [the API contract](docs/API_CONTRACT.md).

Provider/admin: booking accept/decline/offer; providers may submit `POST /v1/activities/:id/corrections` for their own activities.

Partners can submit draft activities; only admins may publish, edit catalogue content or add sessions. All growing lists, including activity sessions, are independently paginated.

Admin: `POST /v1/providers/:id/review`; `POST /v1/activities`; `GET /v1/admin/operations` (counts/flags), `GET /v1/admin/lists/:resource`; `POST /v1/admin/contacts/import`; `POST /v1/admin/contacts/:id/suppress`; `POST /v1/admin/campaigns`; `POST /v1/admin/refunds/:id/complete`.

Pass the Supabase access token as `Authorization: Bearer …`. Identity is checked with Supabase; active status and role are loaded from the database for each request. Booking commands require an `Idempotency-Key` and actions require the displayed booking version. Prices and permissions are checked server-side. No test-token bypass exists in the server.

## Finance and WhatsApp

`FINANCE_WORKFLOW_ENABLED=false` remains the default. The existing reference scaffold now requires an explicit finance capability and trusted AAL2 authentication for verification/refund completion; generic admins and providers cannot perform these actions. This permission foundation does not implement received-funds reconciliation or activate collection. Bank/link instructions, private evidence, ledgers, review deadlines and complete policy-based cancellations remain separate implementation work under the canonical plan.

WhatsApp contact import currently accepts bounded JSON batches (32 KB request limit, up to 1,000 rows). Only explicit E.164 numbers are accepted. Imports create unknown permissions; duplicates preserve previous opt-outs. Campaigns are drafts only. Large CSV/Excel streaming, consent-evidence review, official sender transport, signed webhooks, scheduling and reporting remain outstanding. No external message is sent by these endpoints.

See `docs/IMPLEMENTATION_STATUS.md` for remaining work. Never commit contacts, child details, credentials, receipts or client documents. Environment templates contain placeholders only.

## Dashboard notifications

Socket.IO now serves authenticated live updates on the API port. Partners receive saved notifications for their booking requests and workspace changes, with unread counts, mark-read controls and reconnect refresh in the web app. Families and admins receive their scoped updates too. Run migration 003 before deployment. See `docs/REALTIME.md` for authorization, delivery behavior and persistent-service/reverse-proxy requirements. This does not enable WhatsApp or external push delivery.

## Base platform modules

Migration 002 adds profile names, archived child profiles, listing versions, managed page content, support tickets and deletion-review requests. `npm run db:migrate` now runs ordered SQL files once, records checksums and rejects changes to applied migrations. Test the migration path on staging before deployment.

Authenticated routes include `POST /v1/me`, child `/:id/update` and `/:id/archive`, `GET /v1/manage/activities`, listing `/:id/update` and `/:id/sessions`, correction review, support requests/replies, booking history and account deletion-review requests. Admin page editing is under `/v1/manage/content/:slug`; published pages are available from `GET /v1/content`.

Child edits/archives require ownership and no active participation. Booking names come from accepted snapshots. Alternative-session offers must reference the same activity; acceptance rechecks ages, cutoff and capacity and atomically moves participants. Partial-child offers and policy-based confirmed rescheduling remain separate decisions.

Do not modify SQL files after deployment; append the next migration instead. Supabase Auth redirect allowlists must include the frontend `/reset-password` URL for password recovery. Reset messages depend on the configured Supabase email service.

## Audit hardening — 10 November 2026

Read `docs/AUDIT_2026-11-10.md` for fixed issues, validation and remaining release gates. Use the matching backend/web version and apply **all four migrations** in the intended development/staging project. The API exposes `/health/ready` separately from liveness and reports its finance capability. Booking queries can request `scope=family` or `scope=provider`; server ownership checks remain authoritative. Run `npm test` and `npm audit --audit-level=moderate` along with the existing checks. No client database changes, deployment or external messages are implied by source validation.

## Listing review contract

`POST /v1/bookings` requires `activityVersion` from the reviewed catalog listing. A changed listing returns 409 so the parent must refresh and review the current price and terms. Deploy the matching frontend and backend together.

## Booking search and pagination

The website uses authenticated `GET /v1/bookings/page` for scoped search, status filters, complete workspace counts and cursor pagination. Deploy the updated backend before this frontend; the existing four migrations are sufficient. The legacy booking array API remains available. See `docs/BOOKING_PAGINATION.md`.
