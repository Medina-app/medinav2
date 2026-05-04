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
  // Order matters: child rows first, parent last. Each step is best-effort —
  // a failed DELETE logs but does not abort the rest, so partial leaks from a
  // crashed test don't cascade-block subsequent runs (the missing
  // messages/conversations/patients deletes were the root cause of FK
  // violations in @medina/db's cleanupAll on next run).
  const tryDelete = async (label: string, op: () => PromiseLike<unknown>): Promise<void> => {
    try {
      const result = (await op()) as { error?: { message: string } | null };
      if (result?.error) {
        console.warn(`deleteTestClinic[${label}]: ${result.error.message}`);
      }
    } catch (e) {
      console.warn(`deleteTestClinic[${label}]: ${(e as Error).message}`);
    }
  };

  await tryDelete('messages', () =>
    sb.from('messages').delete().eq('clinic_id', clinicId),
  );
  await tryDelete('conversations', () =>
    sb.from('conversations').delete().eq('clinic_id', clinicId),
  );
  await tryDelete('patients', () =>
    sb.from('patients').delete().eq('clinic_id', clinicId),
  );
  // clinic_integrations has soft-delete trigger — soft-delete first then hard-delete.
  await tryDelete('clinic_integrations:soft', () =>
    sb
      .from('clinic_integrations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('clinic_id', clinicId)
      .is('deleted_at', null),
  );
  await tryDelete('clinic_integrations', () =>
    sb.from('clinic_integrations').delete().eq('clinic_id', clinicId),
  );
  // audit_logs FK to clinics — must clear before DELETE clinics.
  await tryDelete('audit_logs', () =>
    sb.from('audit_logs').delete().eq('clinic_id', clinicId),
  );
  await tryDelete('clinic_members', () =>
    sb.from('clinic_members').delete().eq('clinic_id', clinicId),
  );
  await tryDelete('clinics', () =>
    sb.from('clinics').delete().eq('id', clinicId),
  );
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

export async function createTestIntegration(
  sb: SupabaseClient,
  clinicId: string,
  opts: { type?: string; provider?: string; name?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const type = opts.type ?? 'whatsapp';
  const provider = opts.provider ?? 'kapso';
  const name = opts.name ?? `Test ${type} ${Date.now()}`;
  const { data, error } = await sb.from('clinic_integrations')
    .insert({ clinic_id: clinicId, type, provider, name, status: 'configuring' })
    .select('id, clinic_id').single();
  if (error) throw new Error(`createTestIntegration: ${error.message}`);
  return data as { id: string; clinic_id: string };
}
