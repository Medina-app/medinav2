import { getTenantContext, getSupabaseServerClient } from '@medina/auth'
import { parseAiMemoryConfig } from '@medina/ai'
import { AiMemoryForm } from './ai-memory-form'

export default async function AiMemoryPage() {
  const ctx = await getTenantContext()
  const supabase = await getSupabaseServerClient()

  // Lê metadata.ai_memory pra hidratar o form. Erros não-fatais → default.
  const { data: clinic } = await supabase
    .from('clinics')
    .select('metadata')
    .eq('id', ctx.clinicId)
    .single()

  const config = parseAiMemoryConfig(
    (clinic?.metadata as { ai_memory?: unknown } | undefined)?.ai_memory,
  )
  const canManage = ctx.role === 'owner'

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          Memória da IA
        </h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--luma-text-tertiary)',
            marginTop: 4,
            marginBottom: 0,
            lineHeight: 1.5,
          }}
        >
          Permite que a IA lembre fatos administrativos sobre os pacientes
          entre conversas. <strong>Fatos médicos nunca são armazenados.</strong>
        </p>
      </div>
      <AiMemoryForm
        initialEnabled={config.enabled}
        initialCategories={config.categories}
        canManage={canManage}
      />
    </div>
  )
}
