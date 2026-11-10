# Database changes

Supabase PostgreSQL is the configured database target. On 8 November 2026, migrations 001–005 were applied to the configured hosted development database through the session pooler with certificate and hostname verification enabled. A repeat run applied zero migrations. The restarted local backend returned readiness HTTP 200 and the public catalogue. Subsequent connected tests created clearly fictional accounts, family profiles, organizations, activities and requests. No real family/contact records or payments were used.

Run `npm run db:migrate` against the intended development database. The runner sorts versioned SQL files, serializes migration runs with a PostgreSQL transaction advisory lock, stores SHA-256 checksums in `app.schema_migrations`, and rejects changed applied files. Schema changes and ledger entries commit together. It safely adopts the original manually applied 001 schema because that migration is idempotent.

- `001_platform.sql`: original private domain schema.
- `002_provider_memberships.sql`: organization membership and existing-owner backfill.
- `003_minimal_child_profiles.sql`: optional surname and age-or-birth-date profiles.
- `004_saved_activities.sql`: account-scoped saved activities.
- `005_paginated_list_indexes.sql`: stable list/sort indexes for catalogue, families, providers, sessions, bookings, saves and operational history.

Do not edit an applied migration; add another version. Do not create production tables from startup code. Preserve booking/payment/refund history and tenant ownership. Keep credentials out of Git and use isolated development/staging/production projects. The advisory-lock path is executed in embedded tests, but a real hosted concurrent last-place acceptance case also passed; broader staging concurrency/load verification remains required.

Do not import real contacts or children into this public repository. Contact import data belongs in restricted application storage, not migration fixtures.
