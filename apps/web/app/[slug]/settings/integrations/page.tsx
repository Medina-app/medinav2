import Link from 'next/link'
import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'
import { SchedulingProviderForm } from './scheduling-provider-form'

type Provider = 'none' | 'calcom' | 'pep_ans'

export default async function IntegrationsPage() {
  const ctx = await getTenantContext()
  const supabase = await getSupabaseServerClient()

  const { data: clinic } = await supabase
    .from('clinics')
    .select('scheduling_provider')
    .eq('id', ctx.clinicId)
    .single()

  const provider = ((clinic as { scheduling_provider?: string } | null)?.scheduling_provider ??
    'none') as Provider
  const canManage = hasPermission(ctx.role, 'integration:manage')

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
          Integrações
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
          Seleciona o provedor de scheduling que a IA deve consultar quando o paciente pede agendamento.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          Scheduling Provider
        </h2>
        <SchedulingProviderForm initialProvider={provider} canManage={canManage} />
      </div>

      {provider === 'pep_ans' && (
        <div
          style={{
            padding: 16,
            borderRadius: 8,
            border: '1px solid var(--luma-border)',
            background: 'var(--luma-bg-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--luma-text-primary)',
            }}
          >
            PEP ANS está ativo
          </span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--luma-text-tertiary)',
              lineHeight: 1.5,
            }}
          >
            Catálogo de especialidades, médicos e procedimentos populado via{' '}
            <code>pnpm tsx packages/db/scripts/seed-pep-catalog.ts {ctx.clinicSlug}</code>.
          </span>
          <Link
            href={`/${ctx.clinicSlug}/settings/pep-catalog`}
            style={{
              fontSize: 13,
              color: 'var(--luma-accent)',
              textDecoration: 'none',
              fontWeight: 500,
              alignSelf: 'flex-start',
            }}
          >
            Ver catálogo PEP →
          </Link>
        </div>
      )}
    </div>
  )
}
