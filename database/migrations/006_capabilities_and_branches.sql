-- D11: explicit grants, no role='admin' shortcut and no automatic privilege backfill.
CREATE TABLE app.role_capabilities (
  role text NOT NULL,
  capability text NOT NULL,
  PRIMARY KEY(role,capability)
);
INSERT INTO app.role_capabilities(role,capability) VALUES
  ('finance','bookings.read'), ('finance','payments.read'),
  ('finance','payments.verify'), ('finance','refunds.complete'),
  ('support','bookings.read'), ('support','bookings.override'),
  ('support','support.manage'),
  ('content','content.manage'),
  ('branch_manager','bookings.read'), ('branch_manager','bookings.respond'),
  ('branch_manager','listings.draft'),
  ('booking_staff','bookings.read'), ('booking_staff','bookings.respond'),
  ('content_staff','listings.draft');

CREATE TABLE app.platform_role_grants (
  user_id uuid NOT NULL REFERENCES app.profiles,
  role text NOT NULL CHECK(role IN ('finance','support','content')),
  active boolean NOT NULL DEFAULT true,
  granted_by uuid NOT NULL REFERENCES app.profiles,
  reason text NOT NULL CHECK(length(trim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,role)
);
CREATE TABLE app.provider_branches (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES app.providers,
  name text NOT NULL CHECK(length(trim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  UNIQUE(provider_id,id)
);
-- Reuse provider IDs for the initial branch: deterministic, no fabricated venue data.
INSERT INTO app.provider_branches(id,provider_id,name)
  SELECT id,id,'Default branch' FROM app.providers;
ALTER TABLE app.activities ADD COLUMN branch_id uuid;
UPDATE app.activities SET branch_id=provider_id;
ALTER TABLE app.activities ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE app.activities ADD CONSTRAINT activity_branch_provider
  FOREIGN KEY(provider_id,branch_id) REFERENCES app.provider_branches(provider_id,id);
CREATE TABLE app.provider_branch_roles (
  provider_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('branch_manager','booking_staff','content_staff')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(provider_id,branch_id,user_id,role),
  FOREIGN KEY(provider_id,branch_id) REFERENCES app.provider_branches(provider_id,id),
  FOREIGN KEY(provider_id,user_id) REFERENCES app.provider_memberships(provider_id,user_id)
);
ALTER TABLE app.bookings ADD CONSTRAINT booking_provider_unique UNIQUE(provider_id,id);
CREATE TABLE app.booking_staff_assignments (
  provider_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY(provider_id,booking_id,user_id),
  FOREIGN KEY(provider_id,booking_id) REFERENCES app.bookings(provider_id,id),
  FOREIGN KEY(provider_id,user_id) REFERENCES app.provider_memberships(provider_id,user_id)
);
CREATE INDEX branch_roles_by_user ON app.provider_branch_roles(user_id,provider_id,branch_id) WHERE active;
CREATE INDEX assigned_bookings_by_user ON app.booking_staff_assignments(user_id,booking_id);
CREATE INDEX activity_branch ON app.activities(provider_id,branch_id,id);

-- Database-operator changes are auditable even before a grant-management API exists.
-- No application actor is fabricated for a direct SQL operator action.
CREATE FUNCTION app.audit_permission_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb; current_record jsonb; subject uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current_record := to_jsonb(NEW); END IF;
  subject := COALESCE(current_record->>'user_id',previous->>'user_id')::uuid;
  INSERT INTO app.audit(id,subject_id,action,details)
    VALUES(gen_random_uuid(),subject,'permission.' || lower(TG_OP),
      jsonb_build_object('source','database_operator','database_role',current_user,
        'table',TG_TABLE_NAME,'previous',previous,'current',current_record));
  RETURN NULL;
END
$$;
CREATE TRIGGER platform_grant_audit AFTER INSERT OR UPDATE OR DELETE ON app.platform_role_grants
  FOR EACH ROW EXECUTE FUNCTION app.audit_permission_change();
CREATE TRIGGER branch_role_audit AFTER INSERT OR UPDATE OR DELETE ON app.provider_branch_roles
  FOR EACH ROW EXECUTE FUNCTION app.audit_permission_change();
CREATE TRIGGER booking_assignment_audit AFTER INSERT OR UPDATE OR DELETE ON app.booking_staff_assignments
  FOR EACH ROW EXECUTE FUNCTION app.audit_permission_change();

CREATE FUNCTION app.has_capability(actor uuid, requested text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app.platform_role_grants g
    JOIN app.profiles p ON p.id=g.user_id AND p.active
    JOIN app.role_capabilities c ON c.role=g.role
    WHERE g.user_id=actor AND g.active AND c.capability=requested)
$$;

CREATE FUNCTION app.provider_capability(actor uuid, provider uuid, branch uuid, requested text, booking uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app.provider_memberships m
    JOIN app.profiles u ON u.id=m.user_id AND u.active
    JOIN app.providers p ON p.id=m.provider_id AND p.status='approved'
    JOIN app.provider_branches b ON b.provider_id=p.id AND b.id=branch AND b.active
    WHERE m.user_id=actor AND m.provider_id=provider AND m.active AND (
      (m.role='owner' AND p.owner_id=actor AND requested IN ('bookings.read','bookings.respond','listings.draft')) OR
      EXISTS(SELECT 1 FROM app.provider_branch_roles r JOIN app.role_capabilities c ON c.role=r.role
        WHERE r.provider_id=m.provider_id AND r.branch_id=branch AND r.user_id=actor AND r.active
        AND c.capability=requested AND (r.role <> 'booking_staff' OR EXISTS(
          SELECT 1 FROM app.booking_staff_assignments s WHERE s.provider_id=provider AND s.booking_id=booking AND s.user_id=actor)))
    ))
$$;

CREATE FUNCTION app.can_access_booking(actor uuid, target uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app.bookings b JOIN app.sessions s ON s.id=b.session_id
    JOIN app.activities a ON a.id=s.activity_id JOIN app.profiles u ON u.id=actor AND u.active
    WHERE b.id=target AND (b.parent_id=actor OR app.has_capability(actor,'bookings.read') OR
      app.provider_capability(actor,b.provider_id,a.branch_id,'bookings.read',b.id)))
$$;

REVOKE ALL ON app.role_capabilities,app.platform_role_grants,app.provider_branches,
  app.provider_branch_roles,app.booking_staff_assignments FROM PUBLIC;
REVOKE ALL ON FUNCTION app.has_capability(uuid,text),app.provider_capability(uuid,uuid,uuid,text,uuid),
  app.can_access_booking(uuid,uuid),app.audit_permission_change() FROM PUBLIC;
-- Functions use invoker rights. Keep app private; grant only to the server database role.
