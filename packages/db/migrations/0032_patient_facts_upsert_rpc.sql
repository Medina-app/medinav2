-- ════════════════════════════════════════════════════════════════════════════
-- 0032_patient_facts_upsert_rpc.sql
-- AI-6 fix (CodeRabbit #6): PostgREST .upsert() não suporta partial unique
-- indexes via on_conflict (Postgres requer especificar WHERE clause na
-- conflict target pra inferir partial index). Migração 0031 criou
-- idx_patient_facts_unique_active com WHERE deleted_at IS NULL —
-- supabase-js .upsert(rows, {onConflict: 'clinic_id,patient_id,category,key'})
-- erra com "no unique or exclusion constraint matching ON CONFLICT".
--
-- Esta migração adiciona SECURITY DEFINER RPC que faz INSERT ... ON CONFLICT
-- ... WHERE deleted_at IS NULL DO UPDATE corretamente, mantendo idempotência
-- e preservando soft-deleted rows com forget_reason intacto.
--
-- Caller (worker extract-patient-facts via service_role) substitui
-- .upsert() por .rpc('upsert_patient_facts', {...}).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.upsert_patient_facts(
  p_clinic_id              uuid,
  p_patient_id             uuid,
  p_source_conversation_id uuid,
  p_source_message_id      uuid,
  p_facts                  jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_fact      jsonb;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_was_ins   boolean;
BEGIN
  IF p_facts IS NULL OR jsonb_typeof(p_facts) <> 'array' OR jsonb_array_length(p_facts) = 0 THEN
    RETURN jsonb_build_object('inserted', 0, 'updated', 0);
  END IF;

  FOR v_fact IN SELECT * FROM jsonb_array_elements(p_facts) LOOP
    -- xmax=0 indica INSERT; caso contrário foi UPDATE via ON CONFLICT.
    -- WHERE deleted_at IS NULL infere o partial unique index idx_patient_facts_unique_active.
    WITH upserted AS (
      INSERT INTO public.patient_facts (
        clinic_id, patient_id, category, key, value, confidence,
        source_conversation_id, source_message_id, last_referenced_at
      ) VALUES (
        p_clinic_id, p_patient_id,
        (v_fact->>'category')::text,
        (v_fact->>'key')::text,
        (v_fact->>'value')::text,
        (v_fact->>'confidence')::numeric,
        p_source_conversation_id,
        p_source_message_id,
        NOW()
      )
      ON CONFLICT (clinic_id, patient_id, category, key) WHERE deleted_at IS NULL
      DO UPDATE SET
        value                  = EXCLUDED.value,
        confidence             = EXCLUDED.confidence,
        source_conversation_id = EXCLUDED.source_conversation_id,
        source_message_id      = EXCLUDED.source_message_id,
        last_referenced_at     = EXCLUDED.last_referenced_at,
        updated_at             = NOW()
      RETURNING (xmax = 0) AS was_insert
    )
    SELECT was_insert INTO v_was_ins FROM upserted;

    IF v_was_ins THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_patient_facts(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_patient_facts(uuid, uuid, uuid, uuid, jsonb) TO service_role;
