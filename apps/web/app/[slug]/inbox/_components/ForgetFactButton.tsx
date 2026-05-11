'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { forgetPatientFactsAction } from '../_actions/forget-fact'

interface Props {
  patientId: string
  category?: 'administrative' | 'financial'
  label: string
}

export function ForgetFactButton({ patientId, category, label }: Props) {
  const [pending, startTransition] = useTransition()

  function handleClick() {
    if (pending) return
    const confirmMsg = category
      ? `Apagar memória da categoria ${category} deste paciente? A IA esquece imediatamente.`
      : 'Apagar TODA a memória deste paciente? A IA esquece imediatamente.'
    if (!confirm(confirmMsg)) return

    startTransition(async () => {
      const result = await forgetPatientFactsAction({
        patientId,
        ...(category ? { category } : {}),
      })
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success(`Memória apagada (${result.count ?? 0} fatos).`)
      }
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      style={{
        fontSize: 11,
        color: 'var(--luma-danger)',
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: pending ? 'not-allowed' : 'pointer',
        opacity: pending ? 0.5 : 1,
        textDecoration: 'underline',
      }}
    >
      {pending ? 'Apagando...' : label}
    </button>
  )
}
