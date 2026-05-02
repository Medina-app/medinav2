import { headers } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServerClient } from './supabase/server';
import { TenantAccessDeniedError, NoSessionError } from './errors';
import type { TenantContext, ClinicSummary, ClinicRole } from './types';

export async function assertTenantAccess(
  supabase: SupabaseClient,
  slug: string,
): Promise<ClinicSummary> {
  // RLS policy on clinics: is_clinic_member(id) — returns null if not a member
  const { data: clinic, error: clinicError } = await supabase
    .from('clinics')
    .select('id, slug, name')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();

  if (clinicError || !clinic) throw new TenantAccessDeniedError(slug);

  // RLS on clinic_members: user_id = auth.uid() — returns the user's own membership row
  const { data: membership, error: memberError } = await supabase
    .from('clinic_members')
    .select('role')
    .eq('clinic_id', (clinic as { id: string }).id)
    .maybeSingle();

  if (memberError || !membership) throw new TenantAccessDeniedError(slug);

  const c = clinic as { id: string; slug: string; name: string };
  const m = membership as { role: string };
  return { id: c.id, slug: c.slug, name: c.name, role: m.role as ClinicRole };
}

export async function listUserClinics(supabase: SupabaseClient): Promise<ClinicSummary[]> {
  // RLS on clinic_members: user_id = auth.uid()
  // !inner JOIN drops clinic_members rows whose related clinics row is missing
  const { data, error } = await supabase
    .from('clinic_members')
    .select('role, clinics!inner(id, slug, name)');

  if (error) throw error;
  if (!data || data.length === 0) return [];

  return (data as unknown as Array<{ role: string; clinics: { id: string; slug: string; name: string } }>).map(
    ({ role, clinics }) => ({
      id: clinics.id,
      slug: clinics.slug,
      name: clinics.name,
      role: role as ClinicRole,
    }),
  );
}

export async function getTenantContext(): Promise<TenantContext> {
  const headerStore = await headers();
  const slug = headerStore.get('x-tenant-slug');
  if (!slug) throw new NoSessionError();

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new NoSessionError();

  const clinic = await assertTenantAccess(supabase, slug);

  return {
    user: { id: user.id, email: user.email ?? undefined },
    clinicId: clinic.id,
    clinicSlug: clinic.slug,
    clinicName: clinic.name,
    role: clinic.role,
  };
}
