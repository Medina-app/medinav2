'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Popover } from '@base-ui/react'
import type { ClinicSummary } from '@medina/auth'

interface ClinicSwitcherProps {
  clinics: ClinicSummary[]
  current: ClinicSummary
}

export function ClinicSwitcher({ clinics, current }: ClinicSwitcherProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="clinic-switcher"
        style={{ width: '100%', textAlign: 'left', fontFamily: 'inherit', fontSize: 'inherit' }}
      >
        <div
          className="clinic-avatar"
          style={{ background: 'linear-gradient(135deg, #fb923c, #ec4899)' }}
        />
        <div className="clinic-info">
          <div className="clinic-name">{current.name}</div>
          <div className="clinic-plan">
            {current.role === 'owner' ? 'Proprietário' : 'Membro'}
          </div>
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden={true}
          style={{ opacity: 0.5, width: 14, height: 14, flexShrink: 0 }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          style={{ width: 208, zIndex: 50 }}
        >
          <Popover.Popup
            style={{
              background: 'white',
              border: '1px solid var(--luma-border)',
              borderRadius: 'var(--luma-radius-sm)',
              boxShadow: 'var(--luma-shadow-hover)',
              overflow: 'hidden',
            }}
          >
            {clinics.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => {
                  setOpen(false)
                  router.push(`/${c.slug}`)
                }}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  textAlign: 'left',
                  background: c.id === current.id ? 'var(--luma-bg-subtle)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'inherit',
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 5,
                    background: 'linear-gradient(135deg, #fb923c, #ec4899)',
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 13,
                    color: 'var(--luma-text-primary)',
                    letterSpacing: '-0.01em',
                    fontWeight: c.id === current.id ? 500 : 400,
                  }}
                >
                  {c.name}
                </span>
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
