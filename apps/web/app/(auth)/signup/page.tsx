'use client'

import { useActionState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { signupAction, type SignupState } from './actions'

export default function SignupPage() {
  const [state, formAction, isPending] = useActionState<SignupState, FormData>(signupAction, null)

  useEffect(() => {
    if (state?.error) {
      toast.error(state.error)
    }
  }, [state])

  return (
    <div
      className="auth-card rounded-[12px] p-8"
      style={{ border: '1px solid var(--luma-border)', boxShadow: 'var(--luma-shadow-hero)' }}
    >
      <div className="mb-6">
        <h1
          className="text-xl font-semibold tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          Criar conta
        </h1>
        <p className="text-sm mt-1 tracking-tight" style={{ color: 'var(--luma-text-secondary)' }}>
          Comece agora, grátis
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <div className="space-y-1.5">
          <Label
            htmlFor="name"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Nome completo
          </Label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="Ana Lima"
            autoComplete="name"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="email"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="ana@clinica.com"
            autoComplete="email"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="password"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Senha
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            required
          />
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
          {isPending ? 'Criando conta...' : 'Criar conta'}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs" style={{ color: 'var(--luma-text-tertiary)' }}>
        Já tem conta?{' '}
        <Link
          href="/login"
          className="font-medium hover:underline"
          style={{ color: 'var(--luma-accent)' }}
        >
          Entrar
        </Link>
      </p>
    </div>
  )
}
