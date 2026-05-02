export default function AgentPage() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        padding: '80px 0',
        gap: 8,
      }}
    >
      <h2
        style={{
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '-0.025em',
          color: 'var(--luma-text-primary)',
        }}
      >
        Configurar agente
      </h2>
      <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)' }}>
        Em construção.
      </p>
    </div>
  )
}
