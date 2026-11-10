CREATE TABLE IF NOT EXISTS app.notifications (
 id uuid PRIMARY KEY,
 sequence bigserial UNIQUE,
 audit_id uuid NOT NULL REFERENCES app.audit ON DELETE CASCADE,
 recipient_id uuid NOT NULL REFERENCES app.profiles,
 audience text NOT NULL CHECK(audience IN ('member','admin')),
 kind text NOT NULL CHECK(kind IN ('booking','provider','activity','correction','support','account','admin')),
 subject_id uuid NOT NULL,
 event text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz,
 UNIQUE(audit_id,recipient_id)
);
CREATE INDEX IF NOT EXISTS notifications_recipient ON app.notifications(recipient_id,sequence DESC);
CREATE INDEX IF NOT EXISTS notifications_unread ON app.notifications(recipient_id) WHERE read_at IS NULL;
