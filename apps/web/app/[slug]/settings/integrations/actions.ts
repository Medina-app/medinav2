'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'

const SchedulingProviderEnum = z.enum(['none', 'calcom', 'pep_ans'])

const UpdateSchedulingProviderSchema = z.object({
  provider: SchedulingProviderEnum,
})

export type UpdateSchedulingProviderResult = { error?: string; success?: boolean }

/**
 * M1a-3: atualiza clinics.scheduling_provider (coluna dedicada, M1a-1
 * migration 0037). Permission gate via `integration:manage` (owner + admin).
 * Empty/missing scope retornados como erro estruturado pra UI exibir toast.
 *
 * Coluna NOT NULL DEFAULT 'none' + CHECK enum garante atomic transition:
 * UPDATE rejeita valores fora do enum no banco mesmo se validador app
 * falhasse.
 */
export async function updateSchedulingProviderAction(
  input: unknown,
): Promise<UpdateSchedulingProviderResult> {
  const parsed = UpdateSchedulingProviderSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const ctx = await getTenantContext()
  if (!hasPermission(ctx.role, 'integration:manage')) {
    return { error: 'Sem permissão para alterar integrações.' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase
    .from('clinics')
    .update({ scheduling_provider: parsed.data.provider })
    .eq('id', ctx.clinicId)

  if (error) {
    return { error: error.message }
  }

  revalidatePath(`/${ctx.clinicSlug}/settings/integrations`, 'page')
  return { success: true }
}
