-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Helper: auto-update updated_at ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ─── Helper: read clinic id from session config ───────────────────────────────
CREATE OR REPLACE FUNCTION current_clinic_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_clinic_id', TRUE), '')::UUID;
$$;

-- ─── Helper: set clinic id in session config ──────────────────────────────────
CREATE OR REPLACE FUNCTION set_current_clinic(p_clinic_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_clinic_id', p_clinic_id::TEXT, TRUE);
END;
$$;

-- ─── Table: clinics ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL UNIQUE,
  plan          TEXT        NOT NULL DEFAULT 'trial'
                            CHECK (plan IN ('trial', 'starter', 'pro', 'enterprise')),
  trial_ends_at TIMESTAMPTZ,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_clinics_updated_at
  BEFORE UPDATE ON clinics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinics FORCE ROW LEVEL SECURITY;

-- ─── Table: clinic_members ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID        NOT NULL REFERENCES clinics(id),
  user_id    UUID        NOT NULL REFERENCES auth.users(id),
  role       TEXT        NOT NULL DEFAULT 'member'
                         CHECK (role IN ('owner', 'admin', 'member')),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, user_id)
);

CREATE TRIGGER trg_clinic_members_updated_at
  BEFORE UPDATE ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE clinic_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_members FORCE ROW LEVEL SECURITY;

-- ─── RLS helpers (SECURITY DEFINER prevents RLS recursion) ───────────────────
-- These functions query clinic_members WITHOUT triggering its RLS policies,
-- which is required because clinics + clinic_members policies call each other.

CREATE OR REPLACE FUNCTION is_clinic_member(
  p_clinic_id UUID,
  p_user_id   UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members
    WHERE clinic_id   = p_clinic_id
      AND user_id     = p_user_id
      AND deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION has_clinic_role(
  p_clinic_id UUID,
  p_role      TEXT,
  p_user_id   UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members
    WHERE clinic_id   = p_clinic_id
      AND user_id     = p_user_id
      AND role        = p_role
      AND deleted_at IS NULL
  );
$$;

-- ─── Trigger: enforce at least one owner per clinic ───────────────────────────
CREATE OR REPLACE FUNCTION enforce_at_least_one_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Fires when: soft-deleting an owner OR downgrading an owner's role
  IF (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
     OR (NEW.role != 'owner' AND OLD.role = 'owner')
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM clinic_members
      WHERE clinic_id   = NEW.clinic_id
        AND role        = 'owner'
        AND deleted_at IS NULL
        AND id         != NEW.id
    ) THEN
      RAISE EXCEPTION 'clinic must have at least one owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clinic_members_enforce_owner
  BEFORE UPDATE ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION enforce_at_least_one_owner();

-- ─── Table: audit_logs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID        NOT NULL REFERENCES clinics(id),
  user_id     UUID        REFERENCES auth.users(id),
  action      TEXT        NOT NULL,
  resource    TEXT        NOT NULL,
  resource_id UUID,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- ─── RLS Policies: clinics ────────────────────────────────────────────────────

CREATE POLICY "clinics: members can select"
  ON clinics FOR SELECT
  USING (is_clinic_member(id) AND deleted_at IS NULL);

CREATE POLICY "clinics: owners can update"
  ON clinics FOR UPDATE
  USING (has_clinic_role(id, 'owner'));

-- ─── RLS Policies: clinic_members ────────────────────────────────────────────

CREATE POLICY "clinic_members: members can select own clinic"
  ON clinic_members FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "clinic_members: owners and admins can insert"
  ON clinic_members FOR INSERT
  WITH CHECK (
    has_clinic_role(clinic_id, 'owner')
    OR has_clinic_role(clinic_id, 'admin')
  );

CREATE POLICY "clinic_members: owners and admins can update"
  ON clinic_members FOR UPDATE
  USING (
    has_clinic_role(clinic_id, 'owner')
    OR has_clinic_role(clinic_id, 'admin')
  );

-- ─── RLS Policies: audit_logs ────────────────────────────────────────────────

CREATE POLICY "audit_logs: owners and admins can select"
  ON audit_logs FOR SELECT
  USING (
    has_clinic_role(clinic_id, 'owner')
    OR has_clinic_role(clinic_id, 'admin')
  );

-- Insert is service-role-only: the service role bypasses RLS in Supabase.
-- No INSERT policy needed; application layer writes audit logs via service role.
