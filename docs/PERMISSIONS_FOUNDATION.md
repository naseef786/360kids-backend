# Database and permissions foundation — 17 November 2026

Source: [D11 and the unified decisions](../../docs/DECISIONS.md), [foundation sequence](../../docs/audit/IMPLEMENTATION_PLAN.md), and the owner's implementation-slice instruction on 17 November 2026. This records implementation evidence, not production approval or a new business decision. Existing Express, Supabase Auth and PostgreSQL conventions are preserved.

## Behavior and status

| Area | Status | Evidence |
| --- | --- | --- |
| Transaction failures | Implemented | [database service](../src/database.ts), [tests](../test/database.test.ts): preserve BEGIN/callback/COMMIT errors when rollback fails; evict on failed rollback, fatal PostgreSQL errors and recognized transport failures; release healthy clients once |
| Capability storage | Implemented | New [migration 006](../database/migrations/006_capabilities_and_branches.sql); no historical migrations changed |
| Server enforcement | Implemented for existing routes | [permission guards](../src/permissions.ts), [platform service](../src/platform.ts), [routes](../src/routes.ts), [notification scopes](../src/notifications.ts) |
| Branch/request access | Implemented foundation | SQL predicates cover booking list/count/detail/actions/retries, managed listings, corrections and notification delivery/visibility; composite keys reject cross-provider assignments |
| Operator/team management UI | Partial after 18 November follow-ups | Owner-only branch creation/listing, branch-role and booking-assignment APIs now exist; platform grant management and client UI remain missing |
| Real finance/MFA/deployment | Unverified or separate work | Synthetic embedded PostgreSQL and injected HTTP identities do not prove hosted MFA, reconciliation, client integration or multi-connection revocation/locking behavior |

## Capability matrix

| Explicit role | Granted operations |
| --- | --- |
| finance | Read bookings/payment records, verify payment, complete refunds; mutations require AAL2 and the existing finance feature gate |
| support | Read bookings, perform existing booking overrides with a reason, manage support tickets; no payment evidence/verification |
| content | Manage platform pages and listings/publication/sessions/correction review; no private bookings or finance |
| provider owner | Read/respond to bookings and draft listings across its approved provider's active branches; no finance capabilities |
| branch_manager | Read/respond to requests and draft listings in explicitly assigned active branches |
| booking_staff | Read/respond only to individually assigned requests within explicitly assigned active branches |
| content_staff | Draft listings/request corrections within explicitly assigned active branches; cannot publish or read private requests |
| generic admin | Existing provider review/team and legacy admin operations; no implicit finance/support/content or unrelated booking access |

Platform roles can be combined on one account and need not use the legacy admin profile role. `/v1/me` includes a finite `capabilities` array for clients; server predicates recheck grants rather than trusting client claims. Private payment references are returned only to their submitting family or a finance-capable actor; provider/support views retain booking outcome and a minimal refund status projection.

Supabase validates the exact bearer token before the server reads its `aal` claim; the token subject must match the verified user. Missing assurance defaults to AAL1. Request bodies, user metadata and client assurance headers cannot satisfy step-up. Existing team membership mutations also require AAL2. Frontend MFA enrollment/challenge UX is still separate work; no bypass is supplied.

## Migration and rollout

1. Rehearse all migrations against an isolated staging database with synthetic fixtures. The migration is transactional/checksummed and readiness requires it. It creates each existing provider's `Default branch` using its provider UUID as branch UUID and backfills existing activities. New provider applications create the same default. Activity creation accepts optional `branchId`, defaulting to that provider's default branch.
2. Inventory named operators and staff before deploying the matching API. Existing admins/staff lose implicit private access until explicit grants/branch roles/assignments are provisioned. Owners keep provider access. Do not blanket-grant finance or restore the old generic-admin bypass.
3. A trusted database operator provisions `app.platform_role_grants` (named `granted_by` and nonempty reason), `app.provider_branch_roles` and `app.booking_staff_assignments`. Branch roles require active organization membership and an active branch. An assignment alone cannot grant another branch. Grant/role/assignment inserts, updates and deletes produce audit records including before/after values and database operator identity; direct SQL does not fabricate an application actor. Use the organization's reviewed database access process; there is no public self-elevation endpoint. Application permission changes must retain AAL2 enforcement when a management API is added.
4. Keep the `app` schema private. New functions run with invoker rights; PUBLIC has no table/function access. If migrations and runtime use separate database roles, explicitly provision the server role's necessary table/function privileges. Never grant these to browser roles or expose the schema through the Data API.
5. Run the negative permission suite and real staging parent/provider/operator smoke tests, including actual Supabase AAL2. Keep `FINANCE_WORKFLOW_ENABLED=false` until the wider finance workflow and verified company configuration are ready. Capability grants alone do not prove funds moved.

Rollback: preserve migration 006 and audit/payment history; disable the affected API/finance feature and correct grants or ship a forward fix. Do not roll back to an API that restores generic-admin finance or organization-wide staff access. No automatic schema/data deletion or downgrade is supplied.

## Validation

Baseline command: `node --import tsx --test --test-concurrency=2 test/database.test.ts test/migrations.test.ts test/auth.test.ts` — 5 passed before edits. The initial sandbox run could not spawn Node subprocesses; the permitted rerun passed.

Final checks: `npm test` — **35 passed, 0 failed**; `npm run typecheck` — passed; `npm run build` — passed; `git diff --check` — passed; editor diagnostics — no errors. No lint/format script is configured. [Permission tests](../test/permissions.test.ts) use isolated PGlite SQL plus a local HTTP server, testing generic-admin/provider finance denial, branch/assignment scope, step-up denial, spoofed assurance headers, explicit privileged success, revocation on idempotent retries, notification visibility and tenant foreign keys. Existing test operators are given explicit synthetic grants in [fixture helpers](../test/support/permissions.ts); production migrations do not grant them.

No hosted migration, real funds, deployment, browser/device flow or external message is performed by this slice. Staging concurrency, private evidence/files, funds matching, permission-management UX and complete D11 release certification remain outstanding. No new client decision is needed for this authorized foundation; named operators and actual MFA/company configuration remain activation inputs.

## Follow-up: provider access management API — 18 November 2026

An approved provider owner with a verified AAL2 session can now list and change branch roles and individual booking assignments through paginated `/v1/providers/:id/branches/:branchId/roles` and `/v1/providers/:id/bookings/:bookingId/assignments`. Changes require an active, matching provider/branch/member; assignment grants also require an active `booking_staff` role in the booking's branch. Deactivation remains possible after staff or branch suspension. Every effective change writes application actor audit details as well as the migration's database trigger record. Repeated identical calls do not create another application audit entry. Generic admins, other providers and branch staff cannot manage these records. The backend still has no platform grant-management endpoint, branch creation UI or operator provisioning workflow; trusted database operators must provision platform capabilities.

This API was tested with synthetic database and HTTP actors only. Real Supabase AAL2, hosted migration, owner UI integration and staging concurrency remain unverified.

A second backend increment adds an owner-only paginated branch list and an AAL2-protected branch creation endpoint. New branches have only a name and no automatic staff grants. A branch is an operational scope here; venue address, evidence and public listing details remain separate catalogue work. Synthetic service and HTTP tests cover owner access, generic-admin/other-owner denial, step-up and the default/new-branch list. Branch deactivation and renaming are deliberately not exposed while held bookings and staff scopes depend on branch identity.
