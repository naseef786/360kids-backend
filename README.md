# 360 Kids Backend

Express + TypeScript foundation for shared web/mobile APIs and Supabase integration.

## Implemented

- Liveness endpoint: GET /health/live (process only, no database readiness claim).
- Scaffold status: GET /v1/status.
- Security headers, configured web origin, request-size limit and safe error responses.
- Tested preliminary WhatsApp permission policy for booking updates versus marketing.

Bookings, authentication, Supabase connectivity, database migrations, payments, jobs, contact imports and live WhatsApp sending are not implemented.

## Windows / PowerShell setup

Node.js 24 (tested with 24.22.1):

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

The server listens on http://localhost:4000 by default. It runs without external credentials at this stage.

```powershell
npm run typecheck
npm test
npm run build
npm start
```

## Ownership

This repository owns business rules, SQL migrations, integration adapters and the future versioned API contract. Both [web](https://github.com/naseef786/360kids-web) and [mobile](https://github.com/naseef786/360kids-mobile) consume it. Generate shared client types from one contract; do not duplicate authorization or booking rules.

See [WhatsApp design boundary](docs/whatsapp.md) and [database notes](database/README.md). Payment collection ownership and detailed business rules must be settled before activating money workflows.

Never commit private documents, contact databases, child information, tokens or database URLs. This starter cannot authorize or send WhatsApp messages.
