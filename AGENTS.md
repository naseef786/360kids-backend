# Development conventions

Use TypeScript and the existing repository conventions. Keep changes focused and test the normal flow and relevant failures.

This is an initial scaffold, not a live booking system. Mark sample data and unfinished functionality clearly. Do not collect real child data, accept payments, or send messages from this scaffold.

Business permissions, amounts, deadlines and booking status changes belong in the backend. A submitted request is not confirmed. Keep booking, payment, refund and subscription records separate.

Never commit credentials, customer contact lists, child details, receipts or private project documents. Treat NEXT_PUBLIC_* and EXPO_PUBLIC_* variables as public.

WhatsApp transport is not implemented. Before adding delivery, use the official Business Platform, confirm sender ownership and permission evidence, enforce opt-outs at dispatch, validate webhooks and separate marketing from operational messages. Do not automate WhatsApp Web.

Use npm with the committed lockfile. Keep commands Windows-friendly. Read README.md before working and run the documented checks. Record remaining limitations honestly.
