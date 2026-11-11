# Dashboard notifications

The API hosts authenticated Socket.IO connections on the same port as HTTP, at `/socket.io`. The Next.js dashboard uses them for saved notification counts and refreshing booking, support and workspace data. This increment does not send email, WhatsApp, mobile push or browser system notifications.

## Deployment

1. Configure `DATABASE_URL`, Supabase Auth and `WEB_ORIGIN` for the intended environment. Run `npm run db:migrate` before starting this version; migration 003 adds notification records; migration 004 protects browser-role access and adds query indexes.
2. Run `npm start` as a persistent Node service. Forward both WebSocket upgrades and HTTP polling requests for `/socket.io` to this service. Set the public frontend API URL to the API origin, without `/v1`.
3. Use HTTPS/WSS in deployed environments. `WEB_ORIGIN` must exactly match the frontend origin. Browser connections from other origins are rejected; native clients without an Origin still require authentication.
4. With multiple API instances, use session affinity for Socket.IO HTTP polling. Every instance independently polls PostgreSQL for its connected users, so committed changes from another API instance or the expiry worker are detected. The current implementation does not use a Redis room adapter. Measure database and connection load before scaling.

Keep the expiry worker running separately for deadline transitions. Notification support does not change any booking or finance rule.

## Identity and visibility

The handshake sends a Supabase access token. The server verifies it and loads the active application profile. User IDs, roles and room names supplied by a client cannot select a recipient. Each connection joins only the room generated from its verified identity. There are no client room-subscription or booking-write events.

Notification rows are created in the same transaction as audit records and domain changes. A rollback leaves no notification. A family sees its own booking/account/support events; a partner sees events for its owned provider and active organization memberships. Admins receive operational events. Account and child-profile changes stay with the family. REST reads recheck current ownership, active membership, provider approval and role, including historical notices after revocation.

Socket signals carry only a refresh reason, without child details, receipts or booking contents. Clients obtain current data through the authenticated API. Disabling a profile disconnects it at the next successful sweep, normally within 1.5 seconds. Tokens and active profiles are revalidated every 60 seconds. This is bounded revalidation, not instantaneous token revocation. The web client reconnects when Supabase refreshes its token.

The server permits ten established connections per user and limits handshake attempts to 120 per minute per directly observed IP. A proxy can make several users share that IP; configure and test edge rate limits for the actual topology rather than weakening identity checks. Request bodies/frames are bounded. Do not pass credentials in URLs.

## API and delivery

| Interface                                                | Behavior                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/notifications`                                  | SQL-paginated visible notices with unread count; default 20, maximum 100 |
| `GET /v1/notifications?page=2&pageSize=20`                  | Validated page parameters; `{items,total,page,pageSize,pages,unread}`               |
| `POST /v1/notifications/read` with `{ "ids": ["uuid"] }` | Marks up to 100 owned, currently visible notices read                   |
| Same endpoint with `{ "all": true }`                     | Marks all currently visible notices read                                |
| `sync:required`                                          | Refresh on connect or a committed count/role change                     |
| `sync:unavailable`                                       | Database synchronization failed; show an unavailable state              |

An interval batches connected recipients and compares visible total/unread counts and role, normally every 1.5 seconds. Counts also detect transactions that commit out of sequence; a single maximum sequence cursor would miss some late commits. Other tabs receive read-count changes too. Polls do not overlap within a process.

Socket signals are transient. Reconnect and tab focus trigger authenticated data/feed refresh; persisted notices remain available after disconnection. The client shows connecting, live, reconnecting, offline and unavailable states, with retry and a 30-second visible-tab fallback refresh when disconnected. Duplicate refresh triggers are coalesced. This is not an exactly-once event stream.

## Verification and remaining work

Automated integration tests run actual HTTP/Socket.IO connections against synthetic embedded PostgreSQL records. They cover invalid tokens/origins, client identity/room forgery, tenant isolation, committed request delivery, rollback, reconnect, read state across tabs, demoted admin visibility and disabled-account disconnects. The normal browser polling/upgrade transport and WebSocket-only clients are covered.

Hosted Supabase configuration, reverse-proxy behavior, multi-instance session affinity/load, hosted PostgreSQL concurrency and browser/device interaction still need staging verification. No live client notification has been sent and no deployment is implied by source checks. Retention and account-deletion processing must include saved notifications in the final approved policy.

## Audit follow-up

Connection caps now include pending authenticated handshakes. Revalidation groups matching tokens and runs batches of at most 16. Integration tests cover simultaneous admission, slot reuse and revoked identities. Notification responses contain a server-derived workspace so a partner’s family bookings open the family view. Reconnect/pagination requests are guarded against stale responses. Apply migration 004 before rollout; see `AUDIT_2026-11-10.md` for verification limits.
