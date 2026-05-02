'use client'

import { useActionState, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClinicAction, type OnboardingState } from './actions'

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState<OnboardingState, FormData>(
    createClinicAction,
    null,
  )
  const [clinicName, setClinicName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  useEffect(() => {
    if (!slugEdited) setSlug(toSlug(clinicName))
  }, [clinicName, slugEdited])

  useEffect(() => {
    if (state?.error) toast.error(state.error)
  }, [state])

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label
          htmlFor="name"
          className="text-xs font-medium"
          style={{ color: 'var(--luma-text-secondary)' }}
        >
          Nome da clínica
        </Label>
        <Input
          id="name"
          name="name"
          type="text"
          placeholder="Clínica São Lucas"
          value={clinicName}
          onChange={(e) => setClinicName(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="slug"
          className="text-xs font-medium"
          style={{ color: 'var(--luma-text-secondary)' }}
        >
          Endereço (slug)
        </Label>
        <div className="flex items-center">
          <span
            className="h-8 px-2.5 flex items-center text-sm rounded-l-lg border border-r-0 select-none shrink-0"
            style={{
              borderColor: 'var(--luma-border-strong)',
              color: 'var(--luma-text-tertiary)',
              backgroundColor: 'var(--luma-bg-subtle)',
            }}
          >
            medina.app/
          </span>
          <Input
            id="slug"
            name="slug"
            type="text"
            placeholder="clinica-sao-lucas"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            className="rounded-l-none"
            required
          />
        </div>
        <p className="text-xs" style={{ color: 'var(--luma-text-tertiary)' }}>
          Apenas letras minúsculas, números e hífens.
        </p>
      </div>

      <Button
        type="submit"
        disabled={isPending}
        className="w-full h-9 text-sm font-medium tracking-tight text-white border-transparent"
        style={{
          background: 'linear-gradient(180deg, #1a1a1a, #000000)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.1)',
        }}
      >
        {isPending ? 'Criando clínica...' : 'Criar clínica'}
      </Button>
    </form>
  )
}
