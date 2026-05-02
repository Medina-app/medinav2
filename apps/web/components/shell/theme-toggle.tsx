'use client'
import { useTheme } from 'next-themes'
import { Sun, Moon, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'

const THEMES = [
  { value: 'light', label: 'Claro', Icon: Sun },
  { value: 'dark', label: 'Escuro', Icon: Moon },
  { value: 'system', label: 'Sistema', Icon: Monitor },
] as const

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--luma-border)',
      }}
    >
      <p
        style={{
          fontSize: 11,
          color: 'var(--luma-text-tertiary)',
          marginBottom: 6,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          fontWeight: 500,
        }}
      >
        Tema
      </p>
      <div style={{ display: 'flex', gap: 4 }}>
        {THEMES.map(({ value, label, Icon }) => {
          const active = mounted && theme === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              title={label}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                padding: '5px 0',
                borderRadius: 6,
                border: active
                  ? '1px solid var(--luma-border-strong)'
                  : '1px solid transparent',
                background: active ? 'var(--luma-bg-subtle)' : 'transparent',
                color: active
                  ? 'var(--luma-text-primary)'
                  : 'var(--luma-text-tertiary)',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'inherit',
                transition: 'all 0.12s',
              }}
            >
              <Icon size={12} />
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
