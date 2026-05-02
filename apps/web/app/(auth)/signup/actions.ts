'use server'

import { redirect } from 'next/navigation'
import { SignupSchema, getSupabaseServerClient } from '@medina/auth'

export type SignupState = { error: string } | null

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const result = SignupSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!result.success) {
    return { error: result.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase.auth.signUp({
    email: result.data.email,
    password: result.data.password,
    options: { data: { full_name: result.data.name } },
  })

  if (error) {
    return { error: error.message }
  }

  redirect('/onboarding')
}
