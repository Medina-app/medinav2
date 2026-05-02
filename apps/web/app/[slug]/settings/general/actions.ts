'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'

const UpdateClinicSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório').max(100, 'Nome muito longo'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'O slug deve conter apenas letras minúsculas, números e hifens')
    .min(3, 'Slug muito curto (mínimo 3 caracteres)')
    .max(50, 'Slug muito longo'),
})

export type UpdateClinicResult = { error?: string; success?: boolean }

export async function updateClinicAction(input: unknown): Promise<UpdateClinicResult> {
  const parsed = UpdateClinicSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const ctx = await getTenantContext()
  if (!hasPermission(ctx.role, 'clinic:manage')) {
    return { error: 'Apenas owners podem editar a clínica.' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase
    .from('clinics')
    .update({ name: parsed.data.name, slug: parsed.data.slug })
    .eq('id', ctx.clinicId)

  if (error) {
    if (error.code === '23505') return { error: 'Esse slug já está em uso.' }
    return { error: error.message }
  }

  revalidatePath(`/${parsed.data.slug}/settings/general`, 'page')
  return { success: true }
}
