-- The app schema is server-only, even if accidentally added to a Data API allowlist.
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON SEQUENCES FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON SEQUENCES FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS providers_owner ON app.providers(owner_id);
CREATE INDEX IF NOT EXISTS bookings_parent_created ON app.bookings(parent_id,created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_provider_created ON app.bookings(provider_id,created_at DESC);
CREATE INDEX IF NOT EXISTS activities_provider ON app.activities(provider_id);
CREATE INDEX IF NOT EXISTS sessions_activity_start ON app.sessions(activity_id,starts_at);
CREATE INDEX IF NOT EXISTS children_parent_active ON app.children(parent_id) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS audit_subject_created ON app.audit(subject_id,created_at);
CREATE INDEX IF NOT EXISTS corrections_provider_status ON app.corrections(provider_id,status);
CREATE INDEX IF NOT EXISTS support_owner_created ON app.support(owner_id,created_at DESC);
