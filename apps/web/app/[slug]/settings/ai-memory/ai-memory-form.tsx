'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { saveAiMemoryConfig } from './actions'

type Category = 'administrative' | 'financial'

interface Props {
  initialEnabled: boolean
  initialCategories: Category[]
  canManage: boolean
}

const CATEGORY_OPTIONS: ReadonlyArray<{
  key: Category
  label: string
  description: string
}> = [
  {
    key: 'administrative',
    label: 'Administrativo',
    description: 'Nome preferido, idade, profissão, bairro.',
  },
  {
    key: 'financial',
    label: 'Financeiro',
    description: 'Plano de saúde declarado, forma de pagamento preferida.',
  },
]

export function AiMemoryForm({ initialEnabled, initialCategories, canManage }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [categories, setCategories] = useState<Set<Category>>(new Set(initialCategories))
  const [pending, setPending] = useState(false)

  function toggleCategory(key: Category) {
    const next = new Set(categories)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCategories(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (enabled && categories.size === 0) {
      toast.error('Selecione pelo menos uma categoria.')
      return
    }
    setPending(true)
    const result = await saveAiMemoryConfig({
      enabled,
      categories: Array.from(categories),
    })
    setPending(false)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Configuração salva.')
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: 'var(--luma-bg-card)',
        border: '1px solid var(--luma-border)',
        borderRadius: 'var(--luma-radius-lg)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Label
            htmlFor="ai-memory-enabled"
            style={{ fontSize: 14, fontWeight: 500, color: 'var(--luma-text-primary)' }}
          >
            Ativar memória
          </Label>
          <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
            Quando ligado, o assistente lembra fatos administrativos sobre
            cada paciente entre conversas. Default: desligado.
          </p>
        </div>
        <Switch
          id="ai-memory-enabled"
          checked={enabled}
          onCheckedChange={(v: boolean) => setEnabled(v)}
          disabled={!canManage}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--luma-border)', paddingTop: 20 }}>
        <p
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--luma-text-primary)',
            margin: 0,
            marginBottom: 4,
          }}
        >
          Categorias permitidas
        </p>
        <p
          style={{
            fontSize: 12,
            color: 'var(--luma-text-tertiary)',
            margin: 0,
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          Dados médicos (sintomas, diagnósticos, medicações) <strong>nunca</strong>{' '}
          são armazenados — independente das categorias abaixo.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {CATEGORY_OPTIONS.map((opt) => (
            <div
              key={opt.key}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: 12,
                borderRadius: 8,
                background: 'var(--luma-bg-subtle)',
                border: '1px solid var(--luma-border)',
              }}
            >
              <input
                type="checkbox"
                id={`cat-${opt.key}`}
                checked={categories.has(opt.key)}
                onChange={() => toggleCategory(opt.key)}
                disabled={!canManage || !enabled}
                style={{ marginTop: 3, cursor: canManage && enabled ? 'pointer' : 'not-allowed' }}
              />
              <label
                htmlFor={`cat-${opt.key}`}
                style={{
                  flex: 1,
                  cursor: canManage && enabled ? 'pointer' : 'not-allowed',
                }}
              >
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--luma-text-primary)',
                    margin: 0,
                  }}
                >
                  {opt.label}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: 'var(--luma-text-tertiary)',
                    margin: 0,
                    marginTop: 2,
                  }}
                >
                  {opt.description}
                </p>
              </label>
            </div>
          ))}
        </div>
      </div>

      {canManage ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Salvando...' : 'Salvar configuração'}
          </Button>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', margin: 0 }}>
          Apenas owners podem alterar esta configuração.
        </p>
      )}
    </form>
  )
}
