# API contract — connected web increment

Base path `/v1`. Supabase access tokens identify users; PostgreSQL supplies active status and canonical roles. Request/token metadata never grants privileges. `/me` returns `id,email,role,active,roles`; growing organization membership lists are obtained through paginated `/providers`, rather than embedded in identity. The legacy role field remains compatible with existing backend code.

## Pagination (required for every growing list)

```json
{"items":[],"total":0,"page":1,"pageSize":20,"pages":0}
```

`page` defaults to 1 (1–100000), `pageSize` to 20 (1–100). Invalid/unknown list parameters return 422. Ordering always includes a stable ID tie-breaker. Authorization and filters precede SQL counting and paging; beyond-end pages retain the matching total and return empty items. Exact totals and items share one SQL statement snapshot. Lists do not load all rows into application memory. The previous array/limit/offset contract has been replaced; all clients must use the envelope. Related sessions/members are independently paginated.

| GET list | Additional filters / scope |
| --- | --- |
| `/activities` | Public; `q`, `age` 0–18, `area`, `category`. Literal case-insensitive search; approved providers and published activities only. |
| `/activities/:id/sessions` | Public; future request cutoffs, ordered by start time/ID. No embedded unbounded session array in activity detail. |
| `/children` | Own family only. |
| `/saved` | Own saves, currently visible activities only. |
| `/bookings` | `scope=all,parent,partner`; optional lifecycle `state`. Own family, active approved organization membership or Superadmin scope. |
| `/providers` | Own applications, active approved memberships or Superadmin platform scope; optional `status=pending,approved,rejected,suspended` and `owned=true,false`. |
| `/providers/:id/members` | Owner or Superadmin only; account email/role/active state. |
| `/managed-activities` | Approved organization membership or Superadmin; drafts included. |
| `/admin/lists/:resource` | Superadmin only; `audit`, `corrections`, `refunds`, `contacts`, `campaigns`, `subscriptions`. Contact phone numbers are masked. |

`GET /admin/operations` returns counts and feature flags, not table contents. Identity roles are a small fixed enumeration; booking detail participants are bounded by the ten-child request limit, while payment/refund records have one-record database constraints.

## Public details and authentication

`GET /activities/:id` returns visible activity information and provider name. Hidden or missing activities return 404. `GET /bookings/:id` returns scoped detail, snapshot, participants and separate payment/refund records; unauthorized detail is 404. Invalid IDs are 422. Authenticated responses and authentication failures use `Cache-Control: no-store`. Invalid identity is 401, upstream Auth failure is 503. Disabled profiles cannot access application APIs.

One account can have parent and partner roles. Provider suspension/staff revocation removes organization reads/actions/retries while retaining own-family access. Only an owner or Superadmin can manage existing-account staff; ownership and platform roles cannot be granted through staff APIs.

## Mutations

- `POST /children`, `PUT /children/:id`: preferred `firstName`, optional `surname`, exactly one of `ageYears` (0–17) or real `birthDate`. Age declarations retain uncertainty; no birthday is fabricated. Eligibility and declaration dates use the Dubai calendar; uncertain age boundaries require an exact date.
- `PUT /saved/:id`: `{saved:boolean}`, idempotent account-scoped save/removal.
- `POST /bookings`: `{sessionId,childIds,policyAccepted:true}`; 1–10 distinct own children. Require `Idempotency-Key` (8–128 chars). Totals, age eligibility, policy snapshot and status belong to the server.
- `POST /bookings/:id/actions`: `{action,version,...}` plus idempotency key. Actions: `accept`, `offer`, `accept-offer`, `decline`, `proof`, `verify`, `cancel`. Offers use total `amountFils`; cancellations require reason. Stale versions are 409. Payment submission/verification remain finance-gated.
- `POST /providers`: application name/description. `POST /providers/:id/review`: Superadmin decision; rejection/suspension require reason.
- `POST /providers/:id/members`: existing `userId`, literal `role:staff`, boolean `active`. Activation of disabled accounts is rejected. No invitation email is sent.
- `POST /activities`: approved partner may submit a draft for its organization; only Superadmin may set `published:true`. Includes activity content and initial session/cutoff/capacity.
- `PUT /activities/:id`: Superadmin content/price/policy update; existing booking snapshots remain intact.
- `PUT /activities/:id/publication`: Superadmin `{published:boolean}`; publication requires approved provider.
- `POST /activities/:id/sessions`: Superadmin future start/cutoff and capacity. Existing session allocations are not edited by this endpoint.
- `POST /activities/:id/corrections`: approved partner correction message. `POST /admin/corrections/:id/review`: Superadmin `resolved`/`rejected` plus reason; edit the catalogue before resolving.
- Existing Superadmin bounded contact validation/import, suppression, campaign draft and finance-gated refund completion endpoints remain available. These do not deliver messages or move money.

## Readiness and verification

`/health/live` checks the process. `/health/ready` checks private schema access and Auth configuration, not an actual sign-in. `/status` reports development and finance/messaging flags. Ordered/checksummed migrations 001–005 are applied to the configured development database with verified TLS; no production migration/deployment was performed.

Sixteen synthetic backend test groups pass. Connected website checks additionally verify real Supabase sessions, recovery callback/password change, role journeys, scoped reads, pagination and a real two-connection last-place contention case. Actual email delivery, receipt storage, payment integration, WhatsApp delivery, optional memberships, comprehensive load/device testing and production provisioning remain release work.
