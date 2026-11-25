ALTER TABLE app.contact_submissions
  ADD COLUMN email_status text NOT NULL DEFAULT 'not_queued'
    CHECK (email_status IN ('not_queued','pending','sending','retry','accepted','failed')),
  ADD COLUMN email_attempts integer NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
  ADD COLUMN email_next_attempt_at timestamptz,
  ADD COLUMN email_lease_until timestamptz,
  ADD COLUMN email_accepted_at timestamptz;

CREATE TABLE app.contact_email_attempts (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES app.contact_submissions(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','accepted','failed')),
  UNIQUE (contact_id,attempt_number)
);
CREATE INDEX contact_email_due ON app.contact_submissions(email_next_attempt_at,id)
  WHERE email_status IN ('pending','retry','sending');
REVOKE ALL ON app.contact_email_attempts FROM PUBLIC;
