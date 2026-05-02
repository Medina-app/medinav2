import Link from 'next/link'

export default function LandingPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        zIndex: 2,
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        {/* Logo */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div
            className="logo-mark"
            style={{ width: 36, height: 36, fontSize: 15, borderRadius: 10 }}
          >
            M
          </div>
          <div
            style={{
              fontWeight: 600,
              fontSize: 24,
              letterSpacing: '-0.035em',
              color: 'var(--luma-text-primary)',
            }}
          >
            Medina
          </div>
        </div>

        <p
          style={{
            fontSize: 14,
            color: 'var(--luma-text-secondary)',
            marginBottom: 32,
            letterSpacing: '-0.01em',
            lineHeight: 1.5,
          }}
        >
          CRM para clínicas médicas.
          <br />
          Gerenciamento de pacientes e conversas com IA.
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <Link href="/login" className="btn">
            Entrar
          </Link>
          <Link href="/signup" className="btn btn-primary">
            Criar conta
          </Link>
        </div>
      </div>
    </div>
  )
}
