import { getTenantContext } from '@medina/auth'
import { GeneralSettingsForm } from './general-settings-form'

export default async function GeneralPage() {
  const ctx = await getTenantContext()

  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 24 }}>
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
          Geral
        </h1>
        <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)', marginTop: 4, marginBottom: 0 }}>
          Informações da clínica
        </p>
      </div>
      <GeneralSettingsForm
        name={ctx.clinicName}
        slug={ctx.clinicSlug}
        isOwner={ctx.role === 'owner'}
      />
    </div>
  )
}
