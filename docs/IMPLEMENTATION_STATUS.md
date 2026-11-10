# Phase 1 implementation status

## Implemented in this increment

- Responsive catalog/detail and family/provider/admin interfaces connected to the API; category, area, age, budget and session-date filters; booking status filters and timeline.
- Profile name editing, child editing/archiving with active-booking protection, password recovery/reset UI, and account deletion-review requests.
- Provider-owned draft/public listing visibility, versioned admin listing edits, additional sessions and correction-review outcomes.
- Admin-managed public page content with draft/published versions and plain-text rendering.
- Private support requests, admin replies/status and per-account support history.
- Alternative-session offers, parent acceptance, age/capacity revalidation and immutable original agreement history.
- Transactional, checksummed sequential SQL migrations with a migration lock.
- Supabase identity verification; active-profile and server-role checks; private SQL schema; bounded inputs and API rate limits.
- Own child profiles, multi-child requests, server totals, age validation on session date, accepted-policy snapshots, active child/session duplicate constraints.
- Booking idempotency, stale-version checks, transactional allocation, provider acceptance/decline and revised total requiring parent approval.
- Payment hold windows, finance-gated reference submission/admin verification, cancellation/full-refund obligation and evidence-reference completion.
- Payment-due expiry worker, audit records and notification outbox events.
- Authenticated Socket.IO dashboard signals, transactional saved notifications, scoped feed/read APIs, unread counts, reconnect refresh and cross-tab read updates.
- Provider application/review; admin activity/session publishing; provider correction submission.
- Bounded contact import validation/commit, E.164 validation, unknown permission by default, opt-out preservation, draft campaigns and restricted admin access.

## Explicit implementation assumptions

Email/password login; one parent owns each family profile; one owner per provider; eligibility uses session date; platform-managed session allotments prevent internal overselling; alternative offers keep the same children, may propose another session of the same activity, and expire at the proposed session cutoff without a hold before acceptance. Each is reversible, but final business approval is still required.

## Required before production completion

- Supabase development/staging/production projects, database credentials and initial privileged users.
- Full provider team/branch roles and finance capabilities; approved retention, deletion/consent and recovery requirements.
- Fewer-child offers, policy-based partial cancellations/rescheduling, package/recurring activity rules and pending-request/offer timeout decisions.
- Receipt upload/scan/private access; chosen payment recipient, verifier and gateway integration; late-event reconciliation; applicable taxes/fees.
- Provider subscription plan terms, collection/renewal/expiry implementation and UI; media management and session-change/cancellation operations.
- Email adapter, reliable outbox delivery/retries/escalations and operational alerting; approved reminder/support schedules.
- Large CSV/Excel import pipeline, contact permission evidence, approved WhatsApp sender/templates, signature-validated webhooks, campaign approval/scheduling/limits and live delivery. A JSON import is not the final large-database import workflow.
- Final account deletion processing/retention policy, granular staff roles, finance exports/reports, content/media migration and redirects.
- Approved logo/media, policies/contact content and chosen design reference; server-rendered catalog SEO .
- Multi-connection concurrency tests on PostgreSQL, browser/accessibility/device QA, payment and messaging sandbox tests, backup restoration, load testing, migration rehearsal and release approval.

## Verification limits

Automated tests use synthetic users/children/contacts. Embedded PostgreSQL validates SQL and sequential lifecycle behavior but does not prove hosted multi-session concurrency. There is no production data, payment transaction, contact import or external message in testing. CI builds do not replace browser/real-device tests.

No claim of complete production delivery is made while the above work remains open.

## Base-platform update — 8 November 2026

This increment excludes payment and WhatsApp integration work. Public text and policy pages use admin-published content; no legal content is invented. Existing child/account and single-provider-owner assumptions remain. Client Supabase configuration is still required for connected staging use. Browser visual/device checks and hosted PostgreSQL concurrency tests remain outstanding. Memberships, reviews, discounts and other unapproved extras remain outside the agreed baseline.

## Realtime update — 8 November 2026

Partners now have saved dashboard notifications for owned requests and workspace updates, with automatic booking/workspace refresh through Socket.IO. Family and admin notifications are scoped separately. Local verification includes eight passing backend tests (with real Socket.IO connections and tenant-isolation/reconnect checks), backend TypeScript/build, and web lint/TypeScript/build. The normal browser polling/upgrade transport and WebSocket-only clients are tested. Apply migration 003 and configure the matching persistent backend before using this in staging. Hosted service, proxy, load, browser and device verification remain outstanding; source implementation does not mean the client environment is deployed.

## Audit update — 10 November 2026

See `AUDIT_2026-11-10.md` for findings, fixes and release limits. Migration 004 adds private-role protections and scoped-query indexes. The API now checks required migration checksums and Auth configuration for readiness. Booking, session, privacy, reconnect, retry and navigation defects were corrected; dependency advisories were patched. Backend verification now covers 13 tests, and web verification covers 10 tests plus lint/type/build. Hosted Supabase, interactive browser/device QA, deployment operations and the remaining approved scope still prevent a production-ready claim.
