# Supabase database root CA

`supabase-ca.crt` is a public trust anchor, not a private key or application secret.

Downloaded from Supabase's certificate distribution endpoint:
`https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`.

Issuer: Supabase Root 2021 CA. The certificate expires 26 April 2031. It is used only for the database connection; no system-wide trust settings are changed. Server-chain and hostname verification stay enabled. Update this certificate from Supabase's authenticated Database Settings certificate download when the provider rotates its CA.

Reference: https://supabase.com/docs/guides/platform/ssl-enforcement
