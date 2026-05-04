import type { SupabaseClient } from '@supabase/supabase-js';
import type { Patient } from '@medina/db';
import { mapPatient } from './mappers';

/**
 * Find a patient by E.164 phone within a clinic, or create one with
 * source='whatsapp' if missing. Caller must pass a SupabaseClient already
 * scoped to the right authority (admin/service-role for webhook flows;
 * server client for UI flows where RLS auto-filters by clinic).
 *
 * Race window between SELECT and INSERT is closed by the partial unique
 * index `idx_patients_clinic_phone_unique (clinic_id, phone) WHERE deleted_at IS NULL`
 * — concurrent inserts of the same phone surface as a unique violation.
 */
export async function lookupOrCreatePatientByPhone(
  sb: SupabaseClient,
  clinicId: string,
  phoneE164: string,
  nameHint?: string | null,
): Promise<{ patient: Patient; created: boolean }> {
  const { data: existing, error: selErr } = await sb
    .from('patients')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('phone', phoneE164)
    .is('deleted_at', null)
    .maybeSingle();
  if (selErr) throw new Error(`patient lookup failed: ${selErr.message}`);
  // Preserve user-edited names: if patient already exists, ignore nameHint.
  if (existing) return { patient: mapPatient(existing), created: false };

  const fullName = nameHint && nameHint.trim().length > 0 ? nameHint.trim() : phoneE164;
  const { data: created, error: insErr } = await sb
    .from('patients')
    .insert({
      clinic_id: clinicId,
      phone: phoneE164,
      full_name: fullName,
      source: 'whatsapp',
    })
    .select('*')
    .single();
  if (insErr) throw new Error(`patient create failed: ${insErr.message}`);
  return { patient: mapPatient(created), created: true };
}
