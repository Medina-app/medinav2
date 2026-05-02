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

  const { data: clinicData, error: clinicError } = await admin
    .from('clinics')
    .insert({ name: result.data.name, slug: result.data.slug })
    .select('id, slug')
    .single()

  if (clinicError || !clinicData) {
    if (clinicError?.code === '23505') {
      return { error: 'Este slug já está em uso. Escolha outro.' }
    }
    return { error: 'Erro ao criar clínica. Tente novamente.' }
  }

  const clinic = clinicData as { id: string; slug: string }

  const { error: memberError } = await admin
    .from('clinic_members')
    .insert({ clinic_id: clinic.id, user_id: user.id, role: 'owner' })

  if (memberError) {
    await admin.from('clinics').delete().eq('id', clinic.id)
    return { error: 'Erro ao configurar clínica. Tente novamente.' }
  }

  revalidatePath('/', 'layout')
  redirect(`/${clinic.slug}`)
}
