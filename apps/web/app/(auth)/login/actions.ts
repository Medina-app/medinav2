'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { LoginSchema, getSupabaseServerClient, listUserClinics } from '@medina/auth'

export type LoginState = { error: string } | null

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const result = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!result.success) {
    return { error: result.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase.auth.signInWithPassword(result.data)

  if (error) {
    return { error: 'Email ou senha incorretos' }
  }

  const clinics = await listUserClinics(supabase)
  revalidatePath('/', 'layout')

  const first = clinics[0]
  if (first) {
    redirect(`/${first.slug}`)
  }
  redirect('/onboarding')
}
