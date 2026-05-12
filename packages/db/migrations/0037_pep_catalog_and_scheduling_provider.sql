-- 0037_pep_catalog_and_scheduling_provider.sql
--
-- M1a-1: PEP ANS Doctor Foundation. Adiciona:
-- (a) coluna clinics.scheduling_provider com CHECK enum dedicado
-- (b) 3 tabelas catalog read-only: pep_specialties, pep_doctors, pep_procedures
-- (c) trigger BEFORE INSERT/UPDATE pra validar cross-tenant em specialty_id
--
-- Mednobre é o primeiro consumidor (clinica_id=384, clinica_unidade_id=374
-- em ANS). M1a-1 só schema + RLS; seed/tools/UI vêm em M1a-2 e M1a-3.
--
-- Cross-tenant guard via trigger: pep_doctors.specialty_id e
-- pep_procedures.specialty_id devem apontar pra pep_specialties da MESMA
-- clinic. Trigger SECURITY DEFINER com search_path pg_catalog primeiro
-- (lição PR-D CodeRabbit anti-shadowing).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── clinics.scheduling_provider (coluna dedicada com CHECK enum) ─────────────
ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS scheduling_provider TEXT NOT NULL DEFAULT 'none'
    CHECK (scheduling_provider IN ('none', 'calcom', 'pep_ans'));

COMMENT ON COLUMN public.clinics.scheduling_provider IS
  'Provedor ativo de scheduling. ''none'' = sem integração (tools PEP/calcom retornam ok:false). ''calcom'' = Cal.com self-host (PR AI-4). ''pep_ans'' = ANS PEP (M1a). Dispatcher injeta o client correto no ToolContext.';

-- ─── pep_specialties ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pep_specialties (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  ans_id       text        NOT NULL,
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  active       boolean     NOT NULL DEFAULT true,
  metadata     jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, ans_id)
);

-- ─── pep_doctors ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pep_doctors (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  specialty_id  uuid        NOT NULL REFERENCES public.pep_specialties(id) ON DELETE CASCADE,
  ans_id        text        NOT NULL,
  full_name     text        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  crm           text,
  crm_state     text,
  active        boolean     NOT NULL DEFAULT true,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, ans_id)
);

-- ─── pep_procedures ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pep_procedures (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  specialty_id    uuid        REFERENCES public.pep_specialties(id) ON DELETE SET NULL,
  ans_id          text        NOT NULL,
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  is_nobrecard    boolean     NOT NULL DEFAULT false,
  active          boolean     NOT NULL DEFAULT true,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, ans_id)
);

-- ─── Cross-tenant trigger: specialty_id deve ser da mesma clinic ─────────────
CREATE OR REPLACE FUNCTION public.validate_pep_specialty_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_specialty_clinic uuid;
BEGIN
  IF NEW.specialty_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT clinic_id INTO v_specialty_clinic
  FROM public.pep_specialties WHERE id = NEW.specialty_id;
  IF v_specialty_clinic IS DISTINCT FROM NEW.clinic_id THEN
    RAISE EXCEPTION 'pep: cross-tenant violation specialty.clinic_id=% vs row.clinic_id=%',
      v_specialty_clinic, NEW.clinic_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pep_doctors_specialty_clinic
  BEFORE INSERT OR UPDATE OF specialty_id, clinic_id ON public.pep_doctors
  FOR EACH ROW EXECUTE FUNCTION public.validate_pep_specialty_clinic();

CREATE TRIGGER trg_pep_procedures_specialty_clinic
  BEFORE INSERT OR UPDATE OF specialty_id, clinic_id ON public.pep_procedures
  FOR EACH ROW EXECUTE FUNCTION public.validate_pep_specialty_clinic();

REVOKE EXECUTE ON FUNCTION public.validate_pep_specialty_clinic()
  FROM PUBLIC, anon, authenticated;

-- ─── RLS policies ─────────────────────────────────────────────────────────────
-- Members podem SELECT do próprio clinic. Mutações = service_role only
-- (catálogo só é mutado via seed/admin script em M1a-2).
ALTER TABLE public.pep_specialties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pep_specialties FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pep_doctors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pep_doctors     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pep_procedures  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pep_procedures  FORCE ROW LEVEL SECURITY;

CREATE POLICY "pep_specialties: members select" ON public.pep_specialties
  FOR SELECT USING (is_clinic_member(clinic_id));
CREATE POLICY "pep_doctors: members select" ON public.pep_doctors
  FOR SELECT USING (is_clinic_member(clinic_id));
CREATE POLICY "pep_procedures: members select" ON public.pep_procedures
  FOR SELECT USING (is_clinic_member(clinic_id));

GRANT SELECT ON public.pep_specialties, public.pep_doctors, public.pep_procedures TO authenticated;

-- ─── set_updated_at triggers ──────────────────────────────────────────────────
CREATE TRIGGER trg_pep_specialties_updated_at
  BEFORE UPDATE ON public.pep_specialties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pep_doctors_updated_at
  BEFORE UPDATE ON public.pep_doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pep_procedures_updated_at
  BEFORE UPDATE ON public.pep_procedures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Indexes pra lookups frequentes do agente ─────────────────────────────────
CREATE INDEX idx_pep_specialties_clinic_active
  ON public.pep_specialties (clinic_id) WHERE active;
CREATE INDEX idx_pep_doctors_clinic_specialty_active
  ON public.pep_doctors (clinic_id, specialty_id) WHERE active;
CREATE INDEX idx_pep_procedures_clinic_specialty
  ON public.pep_procedures (clinic_id, specialty_id) WHERE active;
