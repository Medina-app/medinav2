import Link from 'next/link'
import { getTenantContext, getSupabaseServerClient } from '@medina/auth'

interface SpecialtyRow {
  id: string
  ans_id: string
  name: string
  active: boolean
}

interface DoctorRow {
  id: string
  ans_id: string
  full_name: string
  crm: string | null
  crm_state: string | null
  active: boolean
  specialty_id: string
}

interface ProcedureRow {
  id: string
  ans_id: string
  name: string
  is_nobrecard: boolean
  active: boolean
  specialty_id: string | null
}

const PAGE_LIMIT = 100

export default async function PepCatalogPage() {
  const ctx = await getTenantContext()
  const supabase = await getSupabaseServerClient()

  const { data: clinic, error: clinicErr } = await supabase
    .from('clinics')
    .select('scheduling_provider')
    .eq('id', ctx.clinicId)
    .single()

  // Surface clinic-lookup failures explicitly. Defaulting to 'none' would
  // route the user into the "PEP não ativo" branch, masking operational
  // errors (RLS misconfig, DB outage) as legitimate inactive config.
  if (clinicErr || !clinic) {
    return (
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          Catálogo PEP
        </h1>
        <Empty label="Não foi possível carregar a configuração da clínica. Tente recarregar a página." />
      </div>
    )
  }

  const provider = (clinic as { scheduling_provider?: string }).scheduling_provider ?? 'none'

  if (provider !== 'pep_ans') {
    return (
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          Catálogo PEP
        </h1>
        <div
          style={{
            padding: 24,
            borderRadius: 8,
            border: '1px solid var(--luma-border)',
            background: 'var(--luma-bg-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <p style={{ fontSize: 14, color: 'var(--luma-text-primary)', margin: 0 }}>
            PEP ANS não está ativo nesta clínica.
          </p>
          <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
            Ative o provider <code>pep_ans</code> em Integrações e rode o seed script pra popular o catálogo.
          </p>
          <Link
            href={`/${ctx.clinicSlug}/settings/integrations`}
            style={{
              fontSize: 13,
              color: 'var(--luma-accent)',
              textDecoration: 'none',
              fontWeight: 500,
              alignSelf: 'flex-start',
            }}
          >
            Ir pra Integrações →
          </Link>
        </div>
      </div>
    )
  }

  // 3 queries paralelas — catalog é small (max ~100 rows cada na prática).
  // Pagination limit defensivo pra prevenir blow-up futuro; tab UI virá M1b
  // se volume crescer.
  const [specsRes, docsRes, procsRes] = await Promise.all([
    supabase
      .from('pep_specialties')
      .select('id, ans_id, name, active')
      .eq('clinic_id', ctx.clinicId)
      .order('name', { ascending: true })
      .limit(PAGE_LIMIT),
    supabase
      .from('pep_doctors')
      .select('id, ans_id, full_name, crm, crm_state, active, specialty_id')
      .eq('clinic_id', ctx.clinicId)
      .order('full_name', { ascending: true })
      .limit(PAGE_LIMIT),
    supabase
      .from('pep_procedures')
      .select('id, ans_id, name, is_nobrecard, active, specialty_id')
      .eq('clinic_id', ctx.clinicId)
      .order('name', { ascending: true })
      .limit(PAGE_LIMIT),
  ])

  // Surface query failures — `.data ?? []` mascarava erros como "catalog vazio".
  const queryError = specsRes.error ?? docsRes.error ?? procsRes.error
  if (queryError) {
    return (
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          Catálogo PEP
        </h1>
        <Empty label="Não foi possível carregar o catálogo PEP no momento. Tente recarregar a página." />
      </div>
    )
  }

  const specialties = (specsRes.data ?? []) as SpecialtyRow[]
  const doctors = (docsRes.data ?? []) as DoctorRow[]
  const procedures = (procsRes.data ?? []) as ProcedureRow[]

  // Map specialty.id → name para mostrar relação em doctors/procedures.
  const specByName = new Map(specialties.map((s) => [s.id, s.name]))

  return (
    <div style={{ maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 32 }}>
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
          Catálogo PEP
        </h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--luma-text-tertiary)',
            marginTop: 4,
            marginBottom: 0,
            lineHeight: 1.5,
          }}
        >
          Read-only. Atualizações via{' '}
          <code>pnpm tsx packages/db/scripts/seed-pep-catalog.ts {ctx.clinicSlug}</code>.
        </p>
      </div>

      <Section title="Especialidades" count={specialties.length}>
        {specialties.length === 0 ? (
          <Empty label="Nenhuma especialidade cadastrada" />
        ) : (
          <Table headers={['Nome', 'ANS ID', 'Status']}>
            {specialties.map((s) => (
              <tr key={s.id}>
                <Td>{s.name}</Td>
                <Td mono>{s.ans_id}</Td>
                <Td>{s.active ? 'Ativa' : 'Inativa'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Médicos" count={doctors.length}>
        {doctors.length === 0 ? (
          <Empty label="Nenhum médico cadastrado" />
        ) : (
          <Table headers={['Nome', 'Especialidade', 'CRM', 'ANS ID', 'Status']}>
            {doctors.map((d) => (
              <tr key={d.id}>
                <Td>{d.full_name}</Td>
                <Td>{specByName.get(d.specialty_id) ?? '—'}</Td>
                <Td>
                  {d.crm ? `${d.crm}${d.crm_state ? `/${d.crm_state}` : ''}` : '—'}
                </Td>
                <Td mono>{d.ans_id}</Td>
                <Td>{d.active ? 'Ativo' : 'Inativo'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Procedimentos" count={procedures.length}>
        {procedures.length === 0 ? (
          <Empty label="Nenhum procedimento cadastrado" />
        ) : (
          <Table headers={['Nome', 'Especialidade', 'NobreCard', 'ANS ID', 'Status']}>
            {procedures.map((p) => (
              <tr key={p.id}>
                <Td>{p.name}</Td>
                <Td>{p.specialty_id ? (specByName.get(p.specialty_id) ?? '—') : '—'}</Td>
                <Td>{p.is_nobrecard ? 'Sim' : '—'}</Td>
                <Td mono>{p.ans_id}</Td>
                <Td>{p.active ? 'Ativo' : 'Inativo'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          {title}
        </h2>
        <span style={{ fontSize: 12, color: 'var(--luma-text-tertiary)' }}>({count})</span>
      </div>
      {children}
    </section>
  )
}

function Table({
  headers,
  children,
}: {
  headers: readonly string[]
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        border: '1px solid var(--luma-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--luma-text-tertiary)',
                  background: 'var(--luma-bg-subtle)',
                  borderBottom: '1px solid var(--luma-border)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Td({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--luma-border)',
        color: 'var(--luma-text-primary)',
        fontFamily: mono ? 'var(--font-mono, monospace)' : 'inherit',
      }}
    >
      {children}
    </td>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: 24,
        borderRadius: 8,
        border: '1px dashed var(--luma-border)',
        textAlign: 'center',
        fontSize: 13,
        color: 'var(--luma-text-tertiary)',
      }}
    >
      {label}
    </div>
  )
}
