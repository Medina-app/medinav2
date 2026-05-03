import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../apps/web/.env.local') });

export function getAdminSupabase(): SupabaseClient {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) throw new Error('Supabase env vars not set in apps/web/.env.local');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const slugify = (name: string): string =>
  `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export async function createTestClinic(
  sb: SupabaseClient,
  name: string,
): Promise<{ id: string; name: string; slug: string }> {
  const { data, error } = await sb
    .from('clinics')
    .insert({ name, slug: slugify(name) })
    .select('id, name, slug')
    .single();
  if (error) throw new Error(`createTestClinic: ${error.message}`);
  return data as { id: string; name: string; slug: string };
}

export async function deleteTestClinic(sb: SupabaseClient, clinicId: string): Promise<void> {
  // clinic_integrations has soft-delete trigger — soft-delete first then hard-delete.
  await sb.from('clinic_integrations').update({ deleted_at: new Date().toISOString() })
    .eq('clinic_id', clinicId).is('deleted_at', null);
  await sb.from('clinic_integrations').delete().eq('clinic_id', clinicId);
  // Audit logs FK to clinics — must clear before DELETE clinics.
  await sb.from('audit_logs').delete().eq('clinic_id', clinicId);
  await sb.from('clinic_members').delete().eq('clinic_id', clinicId);
  await sb.from('clinics').delete().eq('id', clinicId);
}

export async function createTestPatient(
  sb: SupabaseClient,
  clinicId: string,
  opts: { phone?: string; fullName?: string; source?: string } = {},
): Promise<{ id: string; clinic_id: string; phone: string }> {
  const phone = opts.phone ?? `+5511${Date.now().toString().slice(-9)}`;
  const fullName = opts.fullName ?? `Patient ${Date.now()}`;
  const insert: Record<string, unknown> = { clinic_id: clinicId, full_name: fullName, phone };
  if (opts.source) insert['source'] = opts.source;
  const { data, error } = await sb.from('patients').insert(insert).select('id, clinic_id, phone').single();
  if (error) throw new Error(`createTestPatient: ${error.message}`);
  return data as { id: string; clinic_id: string; phone: string };
}
