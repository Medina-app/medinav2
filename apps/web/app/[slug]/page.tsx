import { getTenantContext } from '@medina/auth'
import type { ReactNode } from 'react'

function Ico({
  children,
  size = 16,
  opacity,
}: {
  children: ReactNode
  size?: number
  opacity?: number
}) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      style={{ width: size, height: size, opacity }}
    >
      {children}
    </svg>
  )
}

export default async function DashboardPage() {
  const { user, clinicName } = await getTenantContext()
  const firstName = user.email?.split('@')[0] ?? 'você'

  return (
    <>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Bom dia, {firstName}</h1>
          <p className="page-subtitle">
            Aqui está o que está acontecendo na {clinicName} hoje.
          </p>
        </div>
        <div className="header-actions">
          <button className="btn">
            <Ico>
              <polyline points="6 9 12 15 18 9" />
            </Ico>
            Hoje
          </button>
          <button className="btn btn-primary">
            <Ico>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </Ico>
            Nova conversa
          </button>
        </div>
      </div>

      {/* Hero card */}
      <div className="hero-card">
        <div className="hero-content">
          <div className="hero-text">
            <h2>Configure seu agente</h2>
            <p>
              Seu agente está pronto para ser configurado. Adicione uma base de
              conhecimento para começar.
            </p>
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <div className="hero-stat-value">0</div>
              <div className="hero-stat-label">conversas IA</div>
            </div>
            <div className="hero-stat">
              <div className="hero-stat-value">0</div>
              <div className="hero-stat-label">handoffs</div>
            </div>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">
            <Ico size={12} opacity={0.5}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </Ico>
            Conversas ativas
          </div>
          <div className="stat-value">0</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <Ico size={12} opacity={0.5}>
              <rect x="3" y="4" width="18" height="18" rx="2" />
            </Ico>
            Agendamentos
          </div>
          <div className="stat-value">0</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <Ico size={12} opacity={0.5}>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
            </Ico>
            Novos pacientes
          </div>
          <div className="stat-value">0</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">
            <Ico size={12} opacity={0.5}>
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <circle cx="12" cy="12" r="4" />
            </Ico>
            Taxa no-show
          </div>
          <div className="stat-value">—</div>
        </div>
      </div>

      {/* Content grid */}
      <div className="content-grid">
        {/* Conversations panel */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Conversas recentes</div>
              <div className="panel-subtitle">Últimas 24 horas</div>
            </div>
          </div>
          <div
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <p style={{ fontSize: 13, color: 'var(--luma-text-secondary)' }}>
              Nenhuma conversa ainda.
            </p>
            <p style={{ fontSize: 12, color: 'var(--luma-text-tertiary)' }}>
              As conversas via WhatsApp aparecerão aqui.
            </p>
          </div>
        </div>

        {/* Activity panel */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Atividade</div>
              <div className="panel-subtitle">Tempo real</div>
            </div>
          </div>
          <div
            style={{
              padding: '48px 24px',
              textAlign: 'center',
            }}
          >
            <p style={{ fontSize: 13, color: 'var(--luma-text-secondary)' }}>
              Nenhuma atividade ainda.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
