# Database changes

Supabase PostgreSQL is the planned datastore. No schema has been applied.

Keep reviewed versioned SQL migrations in this repository once domain rules are ready. Do not create production tables from startup code. Preserve booking/payment/refund history and tenant ownership. Keep credentials out of Git and use isolated development/staging/production projects.

Do not import real contacts or children into this public repository. Contact import data belongs in restricted application storage, not migration fixtures.
