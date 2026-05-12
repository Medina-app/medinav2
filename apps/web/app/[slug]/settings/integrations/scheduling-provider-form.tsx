'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { updateSchedulingProviderAction } from './actions'

type Provider = 'none' | 'calcom' | 'pep_ans'

interface ProviderOption {
  value: Provider
  label: string
  description: string
}

const OPTIONS: ReadonlyArray<ProviderOption> = [
  {
    value: 'none',
    label: 'Nenhum',
    description: 'IA não consulta agenda externa. Tools de scheduling retornam erro.',
  },
  {
    value: 'calcom',
    label: 'Cal.com',
    description: 'Integração Cal.com self-host. Requer clinic_integrations (type=calcom) ativa.',
  },
  {
    value: 'pep_ans',
    label: 'PEP ANS',
    description: 'PEP ANS (Mednobre). Requer env ANS_BASE_URL + ANS_CLINICA_TOKEN configurados.',
  },
]

interface Props {
  initialProvider: Provider
  canManage: boolean
}

export function SchedulingProviderForm({ initialProvider, canManage }: Props) {
  const [selected, setSelected] = useState<Provider>(initialProvider)
  // Tracks the last-saved value so the "Salvar" button disables after success
  // even before revalidatePath rebuilds the server component. Without this,
  // `dirty` stayed true post-save (initialProvider prop only updates on RSC
  // refresh) → user could spam redundant saves.
  const [persistedProvider, setPersistedProvider] = useState<Provider>(initialProvider)
  const [isPending, startTransition] = useTransition()

  const dirty = selected !== persistedProvider

  function handleSave() {
    startTransition(async () => {
      try {
        const result = await updateSchedulingProviderAction({ provider: selected })
        if (result.error) {
          toast.error(result.error)
          return
        }
        setPersistedProvider(selected)
        toast.success('Provider atualizado.')
      } catch {
        // Server action throw (network/serialization). Generic message —
        // err.message may carry backend internals; log technical detail
        // separately if needed.
        toast.error('Erro inesperado ao salvar. Tente novamente.')
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {OPTIONS.map((opt) => {
          const checked = selected === opt.value
          return (
            <label
              key={opt.value}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: 12,
                borderRadius: 8,
                border: `1px solid ${checked ? 'var(--luma-accent)' : 'var(--luma-border)'}`,
                background: checked ? 'var(--luma-bg-subtle)' : 'transparent',
                cursor: canManage ? 'pointer' : 'not-allowed',
                opacity: canManage ? 1 : 0.6,
              }}
            >
              <input
                type="radio"
                name="scheduling_provider"
                value={opt.value}
                checked={checked}
                disabled={!canManage || isPending}
                onChange={() => setSelected(opt.value)}
                style={{ marginTop: 4 }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--luma-text-primary)',
                  }}
                >
                  {opt.label}
                </span>
                <span style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', lineHeight: 1.5 }}>
                  {opt.description}
                </span>
              </div>
            </label>
          )
        })}
      </div>

      {canManage && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || isPending}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              fontSize: 13,
              fontWeight: 600,
              cursor: dirty && !isPending ? 'pointer' : 'not-allowed',
              background: dirty && !isPending ? 'var(--luma-accent)' : 'var(--luma-border)',
              color: dirty && !isPending ? '#fff' : 'var(--luma-text-tertiary)',
            }}
          >
            {isPending ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      )}
    </div>
  )
}
