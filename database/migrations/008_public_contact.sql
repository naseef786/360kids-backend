CREATE TABLE app.contact_submissions (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  body_hash text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  topic text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_submissions_queue ON app.contact_submissions(status,created_at DESC,id);
REVOKE ALL ON app.contact_submissions FROM PUBLIC;
