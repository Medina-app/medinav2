'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'

const FactCategoryEnum = z.enum(['administrative', 'financial'])

const SaveAiMemorySchema = z.object({
  enabled: z.boolean(),
  categories: z.array(FactCategoryEnum).max(2),
})

export type SaveAiMemoryResult = { error?: string; success?: boolean }

export async function saveAiMemoryConfig(input: unknown): Promise<SaveAiMemoryResult> {
  const parsed = SaveAiMemorySchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }
  }

  const ctx = await getTenantContext()
  if (!hasPermission(ctx.role, 'clinic:manage')) {
    return { error: 'Apenas owners podem editar memória da IA.' }
  }

  // Coerência: se enabled=false, não persiste categorias selecionadas (fica
  // visível mas sem efeito). Se enabled=true e categories=[], também é no-op
  // (worker skipped:no_categories) — UI alerta o usuário antes.
  const aiMemory = {
    enabled: parsed.data.enabled,
    categories: parsed.data.categories,
    enabled_at: parsed.data.enabled ? new Date().toISOString() : null,
    enabled_by: parsed.data.enabled ? ctx.user.id : null,
  }

  const supabase = await getSupabaseServerClient()

  // Read current metadata to merge — não sobrescrever outras chaves.
  const { data: clinic, error: readErr } = await supabase
    .from('clinics')
    .select('metadata')
    .eq('id', ctx.clinicId)
    .single()
  if (readErr) {
    return { error: readErr.message }
  }

  const currentMetadata = (clinic?.metadata ?? {}) as Record<string, unknown>
  const newMetadata = { ...currentMetadata, ai_memory: aiMemory }

  const { error } = await supabase
    .from('clinics')
    .update({ metadata: newMetadata })
    .eq('id', ctx.clinicId)

  if (error) {
    return { error: error.message }
  }

  revalidatePath(`/${ctx.clinicSlug}/settings/ai-memory`, 'page')
  return { success: true }
}
