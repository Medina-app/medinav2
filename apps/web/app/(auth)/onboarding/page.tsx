import { getSupabaseServerClient } from '@medina/auth'
import { OnboardingForm } from './onboarding-form'

export default async function OnboardingPage() {
  const supabase = await getSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const fullName = user?.user_metadata['full_name'] as string | undefined
  const firstName = fullName?.split(' ')[0] ?? 'você'

  return (
    <div
      className="bg-white rounded-[12px] p-8"
      style={{ border: '1px solid var(--luma-border)', boxShadow: 'var(--luma-shadow-hero)' }}
    >
      <div className="mb-6">
        <h1
          className="text-xl font-semibold tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          {`Bem-vindo, ${firstName}!`}
        </h1>
        <p className="text-sm mt-1 tracking-tight" style={{ color: 'var(--luma-text-secondary)' }}>
          Vamos criar sua primeira clínica.
        </p>
      </div>
      <OnboardingForm />
    </div>
  )
}
