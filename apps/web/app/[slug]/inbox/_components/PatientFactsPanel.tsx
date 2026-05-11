import type { PatientFact, FactCategory } from '@medina/ai'
import { ForgetFactButton } from './ForgetFactButton'

interface Props {
  facts: PatientFact[]
  patientId: string | null
  memoryEnabled: boolean
  canForget: boolean
  clinicSlug: string
}

const CATEGORY_LABELS: Readonly<Record<FactCategory, string>> = {
  administrative: 'Administrativo',
  financial: 'Financeiro',
}
const CATEGORY_ORDER: ReadonlyArray<FactCategory> = ['administrative', 'financial']

const KEY_LABELS: Readonly<Record<string, string>> = {
  preferred_name: 'Nome preferido',
  full_name: 'Nome completo',
  age: 'Idade',
  profession: 'Profissão',
  address_neighborhood: 'Bairro',
  health_plan_name: 'Plano de saúde',
  preferred_payment_method: 'Pagamento preferido',
}

function formatKey(key: string): string {
  return KEY_LABELS[key] ?? key
}

export function PatientFactsPanel({ facts, patientId, memoryEnabled, canForget, clinicSlug }: Props) {
  const cardStyle: React.CSSProperties = {
    background: 'var(--luma-bg-card)',
    border: '1px solid var(--luma-border)',
    borderRadius: 'var(--luma-radius-lg)',
    padding: 16,
  }

  if (!memoryEnabled) {
    return (
      <aside
        style={{
          height: '100%',
          padding: 16,
          borderLeft: '1px solid var(--luma-border)',
          background: 'var(--luma-bg-subtle)',
          overflowY: 'auto',
        }}
      >
        <div style={cardStyle}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, marginBottom: 8, color: 'var(--luma-text-primary)' }}>
            Memória da IA
          </h3>
          <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', margin: 0, marginBottom: 12, lineHeight: 1.5 }}>
            Esta clínica não tem memória ligada.
          </p>
          <a
            href={`/${clinicSlug}/settings/ai-memory`}
            style={{ fontSize: 12, color: 'var(--luma-accent)', textDecoration: 'underline' }}
          >
            Configurar
          </a>
        </div>
      </aside>
    )
  }

  if (!patientId) {
    return (
      <aside
        style={{
          height: '100%',
          padding: 16,
          borderLeft: '1px solid var(--luma-border)',
          background: 'var(--luma-bg-subtle)',
          overflowY: 'auto',
        }}
      >
        <div style={cardStyle}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, marginBottom: 8 }}>Memória do paciente</h3>
          <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', margin: 0 }}>
            Conversa sem paciente vinculado.
          </p>
        </div>
      </aside>
    )
  }

  const byCategory = new Map<FactCategory, PatientFact[]>()
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, [])
  for (const f of facts) {
    const list = byCategory.get(f.category)
    if (list) list.push(f)
  }

  return (
    <aside
      style={{
        height: '100%',
        padding: 16,
        borderLeft: '1px solid var(--luma-border)',
        background: 'var(--luma-bg-subtle)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--luma-text-primary)' }}>
            Memória do paciente
          </h3>
          {canForget && facts.length > 0 ? (
            <ForgetFactButton patientId={patientId} label="Apagar tudo" />
          ) : null}
        </div>

        {facts.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
            Nenhum fato armazenado ainda. A IA extrai fatos ao final de cada conversa escalada.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {CATEGORY_ORDER.map((cat) => {
              const items = (byCategory.get(cat) ?? []).slice().sort((a, b) => a.key.localeCompare(b.key))
              if (items.length === 0) return null
              return (
                <section key={cat}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                    }}
                  >
                    <p
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--luma-text-tertiary)',
                        margin: 0,
                      }}
                    >
                      {CATEGORY_LABELS[cat]}
                    </p>
                    {canForget ? (
                      <ForgetFactButton patientId={patientId} category={cat} label="Apagar" />
                    ) : null}
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {items.map((f) => (
                      <li
                        key={f.id}
                        style={{
                          fontSize: 12,
                          color: 'var(--luma-text-primary)',
                          lineHeight: 1.4,
                        }}
                      >
                        <span style={{ color: 'var(--luma-text-tertiary)' }}>{formatKey(f.key)}: </span>
                        <span style={{ fontWeight: 500 }}>{f.value}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
