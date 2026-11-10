CREATE TABLE IF NOT EXISTS app.provider_memberships (
  provider_id uuid NOT NULL REFERENCES app.providers,
  user_id uuid NOT NULL REFERENCES app.profiles,
  role text NOT NULL CHECK (role IN ('owner', 'staff')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, user_id)
);

-- Preserve existing ownership. Membership alone never bypasses provider approval.
INSERT INTO app.provider_memberships(provider_id,user_id,role)
SELECT id,owner_id,'owner' FROM app.providers
ON CONFLICT (provider_id,user_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS one_provider_owner
  ON app.provider_memberships(provider_id) WHERE role='owner';
CREATE INDEX IF NOT EXISTS active_provider_memberships
  ON app.provider_memberships(user_id,provider_id) WHERE active;
REVOKE ALL ON app.provider_memberships FROM PUBLIC;
