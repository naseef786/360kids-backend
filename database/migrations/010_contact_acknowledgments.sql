CREATE TABLE app.contact_acknowledgments (
  contact_id uuid PRIMARY KEY REFERENCES app.contact_submissions(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','retry','accepted','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  accepted_at timestamptz
);
CREATE INDEX contact_ack_due ON app.contact_acknowledgments(next_attempt_at,contact_id)
  WHERE status IN ('pending','retry','sending');
CREATE TABLE app.contact_ack_attempts (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES app.contact_acknowledgments(contact_id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','accepted','failed')),
  UNIQUE(contact_id,attempt_number)
);
REVOKE ALL ON app.contact_acknowledgments,app.contact_ack_attempts FROM PUBLIC;
