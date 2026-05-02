'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateClinicAction } from './actions'

interface Props {
  name: string
  slug: string
  isOwner: boolean
}

export function GeneralSettingsForm({ name, slug, isOwner }: Props) {
  const [nameVal, setNameVal] = useState(name)
  const [slugVal, setSlugVal] = useState(slug)
  const [pending, setPending] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    const result = await updateClinicAction({ name: nameVal, slug: slugVal })
    setPending(false)
    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Clínica atualizada.')
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
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Label
          htmlFor="clinic-name"
          style={{ fontSize: 13, fontWeight: 500, color: 'var(--luma-text-primary)' }}
        >
          Nome
        </Label>
        <Input
          id="clinic-name"
          value={nameVal}
          onChange={e => setNameVal(e.target.value)}
          disabled={!isOwner}
          maxLength={100}
          placeholder="Nome da clínica"
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Label
          htmlFor="clinic-slug"
          style={{ fontSize: 13, fontWeight: 500, color: 'var(--luma-text-primary)' }}
        >
          Slug
        </Label>
        <Input
          id="clinic-slug"
          value={slugVal}
          onChange={e => setSlugVal(e.target.value)}
          disabled={!isOwner}
          maxLength={50}
          placeholder="minha-clinica"
        />
        <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
          URL da clínica:{' '}
          <code
            style={{
              fontFamily: 'monospace',
              background: 'var(--luma-bg-subtle)',
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: 11,
            }}
          >
            /{slugVal}/...
          </code>
          {isOwner && (
            <span
              style={{
                display: 'inline-block',
                marginLeft: 8,
                color: 'var(--luma-warning)',
                fontSize: 12,
              }}
            >
              ⚠ Mudar o slug quebra links antigos.
            </span>
          )}
        </p>
      </div>

      {isOwner && (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Salvando...' : 'Salvar alterações'}
          </Button>
        </div>
      )}
    </form>
  )
}
