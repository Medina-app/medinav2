'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getTenantContext, getSupabaseServerClient } from '@medina/auth'
import { forgetFacts } from '@medina/ai'

const ForgetFactSchema = z.object({
  patientId: z.string().uuid(),
  category: z.enum(['administrative', 'financial']).optional(),
})

export type ForgetFactResult = { error?: string; success?: boolean; count?: number }

export async function forgetPatientFactsAction(input: unknown): Promise<ForgetFactResult> {
  const parsed = ForgetFactSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const ctx = await getTenantContext()
  // RPC forget_patient_facts already enforces admin/owner via has_clinic_role.
  // Pré-check defensivo aqui pra retornar erro UX-friendly antes do RPC.
  if (ctx.role !== 'admin' && ctx.role !== 'owner') {
    return { error: 'Apenas admins ou owners podem apagar memória.' }
  }

  const supabase = await getSupabaseServerClient()
  try {
    const count = await forgetFacts(
      supabase,
      parsed.data.patientId,
      parsed.data.category,
      'admin_delete',
    )
    revalidatePath(`/${ctx.clinicSlug}/inbox`, 'page')
    return { success: true, count }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Erro ao apagar memória.' }
  }
}
