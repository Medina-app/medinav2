'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const items = [
  { label: 'Geral', href: 'general' },
  { label: 'Membros', href: 'members' },
  { label: 'Integrações', href: 'integrations' },
]

export function SettingsNav({ slug }: { slug: string }) {
  const pathname = usePathname()

  return (
    <nav
      style={{
        width: 200,
        borderRight: '1px solid var(--luma-border)',
        padding: '24px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        flexShrink: 0,
      }}
    >
      <p
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--luma-text-tertiary)',
          padding: '0 8px',
          marginBottom: 8,
          margin: '0 0 8px',
        }}
      >
        Configurações
      </p>
      {items.map(item => {
        const href = `/${slug}/settings/${item.href}`
        const active = pathname.startsWith(href)
        return (
          <Link
            key={item.href}
            href={href}
            style={{
              display: 'block',
              padding: '7px 8px',
              fontSize: 13,
              borderRadius: 6,
              textDecoration: 'none',
              color: active ? 'var(--luma-text-primary)' : 'var(--luma-text-secondary)',
              background: active ? 'var(--luma-bg-subtle)' : 'transparent',
              fontWeight: active ? 500 : 400,
              transition: 'background 0.15s',
            }}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
