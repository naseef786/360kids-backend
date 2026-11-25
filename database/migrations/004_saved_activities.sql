CREATE TABLE IF NOT EXISTS app.saved_activities (
  user_id uuid NOT NULL REFERENCES app.profiles(id),
  activity_id uuid NOT NULL REFERENCES app.activities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, activity_id)
);
REVOKE ALL ON app.saved_activities FROM PUBLIC;
