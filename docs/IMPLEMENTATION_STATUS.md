# Phase 1 implementation status

## Implemented in this increment

- Backend endpoints for catalog/detail and family/provider/admin operations. The local approved-design web app is now connected to these APIs and real Supabase sessions; existing companion feature PRs still need repository reconciliation before release.
- Supabase identity verification; active-profile and server-role checks; private SQL schema; bounded inputs and API rate limits.
- Own child profiles, multi-child requests, server totals, age validation on session date, accepted-policy snapshots, active child/session duplicate constraints.
- Booking idempotency, stale-version checks, transactional allocation, provider acceptance/decline and revised total requiring parent approval.
- Payment hold windows, finance-gated reference submission/admin verification, cancellation/full-refund obligation and evidence-reference completion.
- Payment-due expiry worker, audit records and notification outbox events.
- Provider application/review; admin activity/session publishing; provider correction submission.
- Bounded contact import validation/commit, E.164 validation, unknown permission by default, opt-out preservation, draft campaigns and restricted admin access.
- Multiple organization memberships; canonical Parent/Partner/Superadmin roles alongside legacy role compatibility; owner/admin staff management; staff revocation and provider-suspension enforcement, including idempotent action retries.
- Filtered, bounded public catalogue and activity detail; scoped booking detail; auth-provider outage handling; schema/auth-configuration readiness endpoint.
- Preferred-name plus age-or-birth-date child profiles and owner-only full-profile update. Eligibility retains uncertainty for age declarations and asks for exact DOB only when required at a boundary.
- Ordered, checksum-protected transactional migrations with original-owner backfill. Sixteen test groups cover the baseline lifecycle, these additions and verified database TLS settings.
- Hosted development database connected through the Supabase session pooler with certificate and hostname verification. Migrations 001–005 applied on 8 November 2026; repeat run applied zero. Local backend readiness and public catalogue returned HTTP 200 after restart; subsequent connected checks created fictional catalogue and family records.

## Explicit implementation assumptions

Email/password login; one parent owns each family profile; one owner per provider; eligibility uses session date; platform-managed session allotments prevent internal overselling; alternative price offers keep the same session/children and expire at the session cutoff without a hold before acceptance. Each is reversible, but final business approval is still required.

## Required before production completion

- Separate staging/production configuration and initial privileged users. Development database access is configured; real sign-in and recovery/password-change round trips passed with synthetic accounts; initial real administrator provisioning remains outstanding.
- Provider invitation workflow, branch-specific roles and granular finance capabilities; approved retention, deletion/consent and recovery requirements.
- Revised sessions/fewer-child offers, policy-based partial cancellations/rescheduling, package/recurring activity rules and pending-request/offer timeout decisions.
- Receipt upload/scan/private access; chosen payment recipient, verifier and gateway integration; late-event reconciliation; applicable taxes/fees.
- Provider subscription plan terms, collection/renewal/expiry implementation and UI; correction review and full catalog edit workflows.
- Email adapter, reliable outbox delivery/retries/escalations and operational alerting; approved reminder/support schedules.
- Large CSV/Excel import pipeline, contact permission evidence, approved WhatsApp sender/templates, signature-validated webhooks, campaign approval/scheduling/limits and live delivery. A JSON import is not the final large-database import workflow.
- Auth recovery, profile editing/deletion, granular staff roles, finance exports/reports, content/media migration and redirects.
- The approved UI kit is recorded in the local web checkout. Production catalogue photography, policies/contact content and API-backed server-rendered SEO still require completion.
- Broader multi-connection/load tests beyond the verified last-place acceptance contention case, exhaustive browser/accessibility/device QA, payment and messaging sandbox tests, backup restoration, load testing, migration rehearsal and release approval.

## Verification limits

Automated tests use synthetic users/children/contacts. Embedded PostgreSQL validates SQL and sequential lifecycle behavior. Additional connected checks against hosted PostgreSQL verified one real concurrent last-place acceptance case; this is not a complete concurrency/load assessment. There is no production data, payment transaction, contact import or external message in testing. CI builds do not replace browser/real-device tests.

No claim of complete production delivery is made while the above work remains open.

## Connected verification — 8 November 2026

The approved-design web app now uses real Supabase sessions and backend APIs for all three workspaces. Every growing API list uses a validated SQL-paginated response; related sessions, member lists and selection lists paginate independently. Saved activities, partner draft submission, catalogue edits/additional sessions, publishing and correction review are connected. Sixteen backend test groups and twelve connected development checks passed, including twenty page render checks, real session/recovery flows and one real PostgreSQL last-place contention case. Browser testing also verified child creation, request submission and mobile pagination/navigation.

A separate fixture-restricted loopback simulation passed confirmation and full-refund recording with fictional references, preserving separate booking/payment/refund records. No money moved; those temporary servers were stopped and the main app retains finance disabled. The normal web/API/expiry-worker processes remain separate. These checks do not complete the production prerequisites above.
