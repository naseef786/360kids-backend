# Database migrations

Business records live in the private `app` schema. Four ordered, checksummed migrations are maintained here. Run `npm run db:migrate` against the intended development/staging database first; never run migrations automatically from web startup. The runner takes a migration lock, preserves applied checksums and rolls back on failure. An existing application schema without a migration ledger is rejected for operator review; never drop existing records to bypass this check.

Migration 004 revokes PUBLIC/anon/authenticated access to application tables and sequences and adds indexes. The server database role must retain the intended application privileges. Keep the schema out of Supabase browser Data API access and keep privileged credentials server-side.

The production package must include `database/migrations` beside `dist`. `/health/ready` compares database migration checksums with these SQL files and checks Auth configuration. It does not establish external service or end-to-end readiness. Hosted migration status and restoration still need staging verification.

Never commit real contacts, children, receipts or database credentials. Use isolated development/staging/production projects and synthetic test data.
