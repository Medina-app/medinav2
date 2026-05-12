-- 0035_clinic_integrations_immutable_clinic_id.sql
--
-- Issue PR-D #7 (post-chat-1 backlog #4): defesa em profundidade no UPDATE
-- de clinic_integrations. Camada app-level (adapter Kapso) adiciona
-- .eq('clinic_id', ctx.clinicId) no UPDATE pra que callers explicitamente
-- filtrem por tenant. Camada DB-level: trigger que IMPEDE qualquer UPDATE
-- que mude clinic_id de uma integration existente — proteção independente
-- da camada app.
--
-- Justificativa: clinic_id de uma integration é parte da identidade. Mover
-- uma integration entre clinics deve ser feito via DELETE + INSERT (com
-- credentials novas), não via UPDATE silencioso que pode pular RLS via
-- service_role.
--
-- BEFORE UPDATE: aborta antes de qualquer side effect (audit trigger AFTER
-- UPDATE em outras tabelas continua intacto). Não precisa SECURITY DEFINER
-- (executa no contexto da operação) — também não precisa search_path
-- explícito porque só usa NEW/OLD records e RAISE.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enforce_clinic_integrations_clinic_id_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
    RAISE EXCEPTION 'clinic_integrations.clinic_id is immutable: cannot change from % to %',
      OLD.clinic_id, NEW.clinic_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clinic_integrations_immutable_clinic_id
  ON public.clinic_integrations;

CREATE TRIGGER trg_clinic_integrations_immutable_clinic_id
  BEFORE UPDATE ON public.clinic_integrations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_clinic_integrations_clinic_id_immutable();

REVOKE EXECUTE ON FUNCTION public.enforce_clinic_integrations_clinic_id_immutable()
  FROM PUBLIC, anon, authenticated;
