import type { ReactNode } from "react";

/* ─────────────────────────────────────────────────
   Icon helpers — exact SVG paths from design-reference.html
───────────────────────────────────────────────── */
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
    >
      {children}
    </svg>
  );
}

function Ico({
  children,
  size = 16,
  opacity,
}: {
  children: ReactNode;
  size?: number;
  opacity?: number;
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
  );
}

/* ─────────────────────────────────────────────────
   Dashboard
───────────────────────────────────────────────── */
export default function Dashboard() {
  return (
    <div className="app">
      {/* ══════════════ SIDEBAR ══════════════ */}
      <aside className="sidebar">
        {/* Logo */}
        <div className="logo">
          <div className="logo-mark">M</div>
          <div className="logo-text">Medina</div>
        </div>

        {/* Clinic switcher */}
        <div className="clinic-switcher">
          <div className="clinic-avatar" />
          <div className="clinic-info">
            <div className="clinic-name">Clínica São Lucas</div>
            <div className="clinic-plan">Plano Pro</div>
          </div>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            style={{ opacity: 0.5, width: 14, height: 14, flexShrink: 0 }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>

        {/* Nav — Operação */}
        <div className="nav-section">
          <div className="nav-label">Operação</div>

          <div className="nav-item active">
            <NavIcon>
              <path d="M3 12l2-2 4 4 8-8 4 4" />
            </NavIcon>
            Dashboard
          </div>

          <div className="nav-item">
            <NavIcon>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </NavIcon>
            Conversas
            <span className="nav-badge">12</span>
          </div>

          <div className="nav-item">
            <NavIcon>
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </NavIcon>
            Pipeline
          </div>

          <div className="nav-item">
            <NavIcon>
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </NavIcon>
            Agenda
          </div>

          <div className="nav-item">
            <NavIcon>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </NavIcon>
            Pacientes
          </div>
        </div>

        {/* Nav — IA */}
        <div className="nav-section">
          <div className="nav-label">IA</div>

          <div className="nav-item">
            <NavIcon>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </NavIcon>
            Configurar agente
          </div>

          <div className="nav-item">
            <NavIcon>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </NavIcon>
            Base de conhecimento
          </div>
        </div>

        {/* Nav — Conta */}
        <div className="nav-section">
          <div className="nav-label">Conta</div>

          <div className="nav-item">
            <NavIcon>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </NavIcon>
            Uso
          </div>

          <div className="nav-item">
            <NavIcon>
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v6m0 6v6" />
            </NavIcon>
            Configurações
          </div>
        </div>
      </aside>

      {/* ══════════════ MAIN ══════════════ */}
      <main className="main">
        {/* Page header */}
        <div className="page-header">
          <div>
            <h1 className="page-title">Bom dia, Gabriel</h1>
            <p className="page-subtitle">
              Aqui está o que está acontecendo na Clínica São Lucas hoje.
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
              <h2>Seu agente está performando bem</h2>
              <p>
                87% das conversas resolvidas sem intervenção humana nas últimas
                24h.
              </p>
            </div>
            <div className="hero-stats">
              <div className="hero-stat">
                <div className="hero-stat-value">142</div>
                <div className="hero-stat-label">conversas IA</div>
              </div>
              <div className="hero-stat">
                <div className="hero-stat-value">23</div>
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
            <div className="stat-value">12</div>
            <div className="stat-change">↑ 8% vs ontem</div>
          </div>

          <div className="stat-card">
            <div className="stat-label">
              <Ico size={12} opacity={0.5}>
                <rect x="3" y="4" width="18" height="18" rx="2" />
              </Ico>
              Agendamentos
            </div>
            <div className="stat-value">38</div>
            <div className="stat-change">↑ 12% vs semana</div>
          </div>

          <div className="stat-card">
            <div className="stat-label">
              <Ico size={12} opacity={0.5}>
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
              </Ico>
              Novos pacientes
            </div>
            <div className="stat-value">7</div>
            <div className="stat-change">↑ 40% vs ontem</div>
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
            <div className="stat-value">4.2%</div>
            <div className="stat-change down">↓ 1.8% vs mês</div>
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
              <button className="btn">Ver todas</button>
            </div>

            <div className="conversation-item">
              <div className="avatar">MR</div>
              <div className="conv-content">
                <div className="conv-top">
                  <div className="conv-name">Maria Rodrigues</div>
                  <div className="conv-time">há 2 min</div>
                </div>
                <div className="conv-preview">
                  Confirmar consulta de amanhã às 14h com Dr. Silva, por favor.
                </div>
                <div className="conv-meta">
                  <span className="badge badge-ai">Agente IA</span>
                  <span className="badge badge-pending">Aguardando</span>
                </div>
              </div>
            </div>

            <div className="conversation-item">
              <div className="avatar green">JC</div>
              <div className="conv-content">
                <div className="conv-top">
                  <div className="conv-name">João Carvalho</div>
                  <div className="conv-time">há 12 min</div>
                </div>
                <div className="conv-preview">
                  Obrigado, consulta confirmada para sexta-feira. Até lá.
                </div>
                <div className="conv-meta">
                  <span className="badge badge-confirmed">Confirmado</span>
                </div>
              </div>
            </div>

            <div className="conversation-item">
              <div className="avatar orange">AS</div>
              <div className="conv-content">
                <div className="conv-top">
                  <div className="conv-name">Ana Silva</div>
                  <div className="conv-time">há 28 min</div>
                </div>
                <div className="conv-preview">
                  Preciso remarcar minha consulta. Tem horário disponível na
                  próxima semana?
                </div>
                <div className="conv-meta">
                  <span className="badge badge-ai">Agente IA</span>
                  <span className="badge badge-new">Novo</span>
                </div>
              </div>
            </div>

            <div className="conversation-item">
              <div className="avatar blue">RP</div>
              <div className="conv-content">
                <div className="conv-top">
                  <div className="conv-name">Rafael Pereira</div>
                  <div className="conv-time">há 1 h</div>
                </div>
                <div className="conv-preview">
                  Quanto custa a consulta dermatológica? Vocês atendem convênio
                  Unimed?
                </div>
                <div className="conv-meta">
                  <span className="badge badge-ai">Agente IA</span>
                </div>
              </div>
            </div>

            <div className="conversation-item">
              <div className="avatar amber">CL</div>
              <div className="conv-content">
                <div className="conv-top">
                  <div className="conv-name">Carla Lima</div>
                  <div className="conv-time">há 2 h</div>
                </div>
                <div className="conv-preview">
                  Bom dia, gostaria de informações sobre o tratamento estético...
                </div>
                <div className="conv-meta">
                  <span className="badge badge-confirmed">Resolvido</span>
                </div>
              </div>
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
            <div className="activity-list">
              <div className="activity-item">
                <div className="activity-dot green" />
                <div>
                  <div className="activity-text">
                    Agente confirmou consulta de{" "}
                    <strong>Maria Rodrigues</strong>
                  </div>
                  <div className="activity-time">há 2 min</div>
                </div>
              </div>
              <div className="activity-item">
                <div className="activity-dot" />
                <div>
                  <div className="activity-text">
                    Nova conversa de <strong>Ana Silva</strong> via WhatsApp
                  </div>
                  <div className="activity-time">há 28 min</div>
                </div>
              </div>
              <div className="activity-item">
                <div className="activity-dot amber" />
                <div>
                  <div className="activity-text">
                    Handoff para <strong>Dra. Mendes</strong> — caso clínico
                  </div>
                  <div className="activity-time">há 45 min</div>
                </div>
              </div>
              <div className="activity-item">
                <div className="activity-dot green" />
                <div>
                  <div className="activity-text">
                    Agendamento sincronizado com iClinic
                  </div>
                  <div className="activity-time">há 1 h</div>
                </div>
              </div>
              <div className="activity-item">
                <div className="activity-dot gray" />
                <div>
                  <div className="activity-text">
                    <strong>Carla Lima</strong> entrou no funil de consulta
                  </div>
                  <div className="activity-time">há 2 h</div>
                </div>
              </div>
              <div className="activity-item">
                <div className="activity-dot" />
                <div>
                  <div className="activity-text">
                    Lembrete enviado para 8 pacientes
                  </div>
                  <div className="activity-time">há 3 h</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
