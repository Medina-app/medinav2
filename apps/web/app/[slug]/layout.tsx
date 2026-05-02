import { getTenantContext, listUserClinics, getSupabaseServerClient } from '@medina/auth'
import type { ClinicSummary } from '@medina/auth'
import { Sidebar } from '@/components/shell/sidebar'
import { Topbar } from '@/components/shell/topbar'

interface SlugLayoutProps {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}

export default async function SlugLayout({ children }: SlugLayoutProps) {
  const [context, supabase] = await Promise.all([
    getTenantContext(),
    getSupabaseServerClient(),
  ])

  const clinics = await listUserClinics(supabase)

  const currentClinic: ClinicSummary =
    clinics.find((c) => c.slug === context.clinicSlug) ?? {
      id: context.clinicId,
      slug: context.clinicSlug,
      name: context.clinicName,
      role: context.role,
    }

  return (
    <div className="app">
      <Sidebar
        clinicSlug={context.clinicSlug}
        clinics={clinics}
        currentClinic={currentClinic}
      />
      <div
        style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', overflow: 'hidden' }}
      >
        <Topbar email={context.user.email} />
        <main className="main">{children}</main>
      </div>
    </div>
  )
}
