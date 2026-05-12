'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { CreateClinicSchema, getSupabaseServerClient, getSupabaseAdminClient } from '@medina/auth'

export type OnboardingState = { error: string } | null

export async function createClinicAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const result = CreateClinicSchema.safeParse({
    name: formData.get('name'),
    slug: formData.get('slug'),
  })

  if (!result.success) {
    return { error: result.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const supabase = await getSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Sessão expirada. Faça login novamente.' }
  }

  const admin = getSupabaseAdminClient()

  // PR-D #10: atomic RPC replaces dual-insert + manual cleanup. clinic +
  // clinic_members(owner) commit in one transaction; failure at any step
  // rolls back automatically — no orphan-clinic window.
  const { data, error } = await admin.rpc('create_clinic_with_owner', {
    p_name: result.data.name,
    p_slug: result.data.slug,
    p_user_id: user.id,
  })

  if (error) {
    if (error.code === '23505') {
      return { error: 'Este slug já está em uso. Escolha outro.' }
    }
    return { error: 'Erro ao criar clínica. Tente novamente.' }
  }

  const row = (Array.isArray(data) ? data[0] : data) as { id: string; slug: string } | null
  if (!row) {
    return { error: 'Erro ao criar clínica. Tente novamente.' }
  }

  revalidatePath('/', 'layout')
  redirect(`/${row.slug}`)
}
