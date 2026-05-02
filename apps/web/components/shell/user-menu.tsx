'use client'

import { Menu } from '@base-ui/react'
import { logoutAction } from '@/app/[slug]/actions'
import { ThemeToggle } from './theme-toggle'

interface UserMenuProps {
  email: string | undefined
}

export function UserMenu({ email }: UserMenuProps) {
  const initial = (email?.[0] ?? '?').toUpperCase()

  return (
    <Menu.Root>
      <Menu.Trigger
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #a78bfa, #ec4899)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontWeight: 500,
          fontSize: '12.5px',
          letterSpacing: '-0.01em',
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {initial}
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} style={{ zIndex: 50 }}>
          <Menu.Popup
            style={{
              minWidth: 200,
              background: 'var(--luma-bg-card)',
              border: '1px solid var(--luma-border)',
              borderRadius: 'var(--luma-radius-md)',
              boxShadow: 'var(--luma-shadow-hover)',
              overflow: 'hidden',
              outline: 'none',
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                fontSize: 12,
                color: 'var(--luma-text-secondary)',
                borderBottom: '1px solid var(--luma-border)',
                letterSpacing: '-0.005em',
              }}
            >
              {email}
            </div>

            <ThemeToggle />

            <form action={logoutAction}>
              <Menu.Item
                nativeButton
                render={
                  <button
                    type="submit"
                    style={{
                      width: '100%',
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  />
                }
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  textAlign: 'left',
                  fontSize: '13.5px',
                  color: 'var(--luma-text-primary)',
                  letterSpacing: '-0.005em',
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                Sair
              </Menu.Item>
            </form>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
