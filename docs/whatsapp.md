# WhatsApp integration boundary

Status: planned integration. Only a pure preliminary permission check is implemented and tested. No contacts, credentials, transport, webhook, campaign endpoint or live sending are configured.

## Proposed design

Use the official WhatsApp Business Platform, directly or through an approved provider. The backend owns tokens, sender configuration, template eligibility, opt-out checks and durable delivery. Web/mobile clients never call the provider with privileged credentials.

Separate booking updates from marketing. Record evidence, scope, source and timestamp of permission; unknown imported records remain ineligible. The preliminary check is deliberately insufficient to authorize a send: production delivery also requires sender ownership, validated contact identity, current permission evidence, correct template/window, budget and account limits.

Imports need upload validation, E.164 phone normalization with explicit country handling, duplicate detection, preview/dry-run, errors, resumable batches and a permanent opt-out/suppression record. Re-importing a number must never erase suppression. Do not infer permission from a prior booking or create family accounts from a marketing list.

Campaigns need segments, approved template/version/language, sample preview, permitted audience counts, budget checks, named authorization, scheduling, pause/cancel and an audit record. Recheck eligibility before each queued send. Operational messages must have their own priority so a campaign cannot delay a booking update.

Webhook handling must verify signatures on the raw body, deduplicate events, store provider IDs and reconcile sent/delivered/read/failed without regressing on out-of-order events. Handle inbound opt-outs and escalate support replies; a full omnichannel agent inbox is a separate scope decision. Avoid duplicate sends after ambiguous provider timeouts.

## Decisions before integration

Sender ownership and number; existing Business App/API setup; direct Cloud API versus provider; API onboarding/coexistence requirements; list format/volume and lawful use; permission evidence and suppression history; message languages/templates; sender budgets/limits; staff roles and support ownership.

## References

- https://business.whatsapp.com/policy
- https://business.whatsapp.com/developers/developer-hub

Check current provider policies, limits, account eligibility and pricing during integration. Do not assume a historical chat database can be imported as API chat history.
