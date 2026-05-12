# Issue 5 — App Shell (Tenant-Aware Layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the dashboard from `/` to `/[slug]/`, create a full Server-Component shell (sidebar + topbar + layout) powered by `getTenantContext()`, and wire in live tenant data so the user sees their real clinic name after onboarding.

**Architecture:** A `[slug]/layout.tsx` Server Component calls `getTenantContext()` (reads `x-tenant-slug` injected by the middleware) and `listUserClinics()`, then renders a CSS-grid shell: a 240 px `Sidebar` (Server) + a flex-column right panel with a `Topbar` (Server) above the page `<main>`. Active nav state lives in a thin `NavItem` Client Component that uses `usePathname()`. Clinic switching and user logout are isolated Client Components. The root `/` becomes a minimal landing page.

**Tech Stack:** Next.js 15 App Router · TypeScript strict · Tailwind v4 · `@base-ui/react ^1.4.1` (for Popover + Menu) · `@medina/auth` (getTenantContext, listUserClinics, getSupabaseServerClient) · globals.css Luma tokens

---

## File Map

### Created
| Path | Responsibility |
|------|---------------|
| `apps/web/app/[slug]/layout.tsx` | Server layout: calls getTenantContext + listUserClinics, renders `.app` grid |
| `apps/web/app/[slug]/page.tsx` | Dashboard page with real greeting + empty-state panels |
| `apps/web/app/[slug]/actions.ts` | `logoutAction` server action |
| `apps/web/app/[slug]/inbox/page.tsx` | Placeholder |
| `apps/web/app/[slug]/pipeline/page.tsx` | Placeholder |
| `apps/web/app/[slug]/calendar/page.tsx` | Placeholder |
| `apps/web/app/[slug]/patients/page.tsx` | Placeholder |
| `apps/web/app/[slug]/settings/page.tsx` | Placeholder |
| `apps/web/components/shell/nav-item.tsx` | Client: `usePathname()` → `.active` class |
| `apps/web/components/shell/sidebar.tsx` | Server: logo + ClinicSwitcher + all nav sections |
| `apps/web/components/shell/clinic-switcher.tsx` | Client: Base UI `Popover` clinic list |
| `apps/web/components/shell/topbar.tsx` | Server: 56 px bar + UserMenu |
| `apps/web/components/shell/user-menu.tsx` | Client: Base UI `Menu` with logout |
| `apps/web/components/shell/__tests__/nav-item.test.ts` | Pure-function test for active-state logic |

### Modified
| Path | Change |
|------|--------|
| `apps/web/app/page.tsx` | Replace 436-line dashboard with 30-line landing |
| `apps/web/app/globals.css` | Add `.topbar` rule; add `flex: 1` to `.main` |

---

## Task 1 — CSS additions (globals.css)

**Files:**
- Modify: `apps/web/app/globals.css` (after the `.main` block, ~line 430)

- [ ] **Step 1: Add `.topbar` rule and `flex: 1` to `.main`**

Open `apps/web/app/globals.css`. After the existing `.main` block:

```css
/* ═══ MAIN — grows to fill right column ═══ */
.main {
    padding: 24px 32px 48px;
    overflow-x: hidden;
    flex: 1;      /* ← add this line */
}
```

Then append at the end of the file:

```css
/* ═══ TOPBAR ═══ */
.topbar {
    height: 56px;
    border-bottom: 1px solid var(--luma-border);
    padding: 0 32px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    background: rgba(255, 255, 255, 0.6);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    position: sticky;
    top: 0;
    z-index: 10;
    flex-shrink: 0;
}
```

- [ ] **Step 2: Verify build still works**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors (globals.css changes are pure CSS, no TS impact).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "chore: add .topbar and flex:1 to .main in globals.css"
```

---

## Task 2 — NavItem client component + tests

**Files:**
- Create: `apps/web/components/shell/nav-item.tsx`
- Create: `apps/web/components/shell/__tests__/nav-item.test.ts`

The active-state check is extracted as a pure function so it can be unit-tested without React.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/web/components/shell/__tests__/nav-item.test.ts
import { describe, it, expect } from 'vitest'
import { isNavActive } from '../nav-item'

describe('isNavActive', () => {
  it('exact=true: matches only the exact path', () => {
    expect(isNavActive('/sao-lucas', '/sao-lucas', true)).toBe(true)
    expect(isNavActive('/sao-lucas/inbox', '/sao-lucas', true)).toBe(false)
  })

  it('exact=false: matches exact or prefix with trailing slash', () => {
    expect(isNavActive('/sao-lucas/inbox', '/sao-lucas/inbox', false)).toBe(true)
    expect(isNavActive('/sao-lucas/inbox/123', '/sao-lucas/inbox', false)).toBe(true)
    expect(isNavActive('/sao-lucas/pipeline', '/sao-lucas/inbox', false)).toBe(false)
  })

  it('never marks a sibling route as active', () => {
    expect(isNavActive('/sao-lucas/patients', '/sao-lucas/pipeline', false)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter @medina/web test --run components/shell/__tests__/nav-item.test.ts
```

Expected: `Error: Cannot find module '../nav-item'`

- [ ] **Step 3: Create NavItem component with exported pure function**

```tsx
// apps/web/components/shell/nav-item.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export function isNavActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(href + '/')
}

interface NavItemProps {
  href: string
  exact?: boolean
  children: ReactNode
}

export function NavItem({ href, exact = false, children }: NavItemProps) {
  const pathname = usePathname()
  const active = isNavActive(pathname, href, exact)
  return (
    <Link href={href} className={`nav-item${active ? ' active' : ''}`}>
      {children}
    </Link>
  )
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter @medina/web test --run components/shell/__tests__/nav-item.test.ts
```

Expected: `3 tests passed`

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/shell/nav-item.tsx apps/web/components/shell/__tests__/nav-item.test.ts
git commit -m "feat: NavItem client component with isNavActive pure function + tests"
```

---

## Task 3 — ClinicSwitcher client component

**Files:**
- Create: `apps/web/components/shell/clinic-switcher.tsx`

Uses `@base-ui/react` `Popover` (already in `package.json`). No `asChild` — `Popover.Trigger` renders a `<button>` which we style via `className`.

- [ ] **Step 1: Create the component**

```tsx
// apps/web/components/shell/clinic-switcher.tsx
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
                  className="clinic-avatar"
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
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors. If `Popover.Positioner` isn't found, verify the Base UI exports with: `node -e "const b = require('@base-ui/react'); console.log(Object.keys(b.Popover))"` in `apps/web/`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/shell/clinic-switcher.tsx
git commit -m "feat: ClinicSwitcher with Base UI Popover, no asChild"
```

---

## Task 4 — UserMenu client component

**Files:**
- Create: `apps/web/components/shell/user-menu.tsx`

Uses Base UI `Menu`. The logout is a `<form action={logoutAction}>` inside a `Menu.Item` rendered as a `<button type="submit">` — this is the most reliable pattern for server-action redirects.

**Note:** `logoutAction` lives in `apps/web/app/[slug]/actions.ts` which doesn't exist yet. Create a stub in Task 7. During typecheck the path `@/app/[slug]/actions` is valid — the brackets are literal characters in the filesystem path.

- [ ] **Step 1: Create the component**

```tsx
// apps/web/components/shell/user-menu.tsx
'use client'

import { Menu } from '@base-ui/react'
import { logoutAction } from '@/app/[slug]/actions'

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
              background: 'white',
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

            <form action={logoutAction}>
              <Menu.Item
                render={<button type="submit" style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }} />}
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
```

- [ ] **Step 2: Typecheck (skip if logoutAction stub not yet created — Task 7 comes next)**

This task's code will fail typecheck until Task 7 creates the stub. Move on to Task 5, then come back after Task 7.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/shell/user-menu.tsx
git commit -m "feat: UserMenu client component with Base UI Menu"
```

---

## Task 5 — Sidebar server component

**Files:**
- Create: `apps/web/components/shell/sidebar.tsx`

Server Component. Imports `NavItem` (Client) and `ClinicSwitcher` (Client) — this is fine; Server Components can import Client Components.

- [ ] **Step 1: Create the component**

```tsx
// apps/web/components/shell/sidebar.tsx
import type { ReactNode } from 'react'
import type { ClinicSummary } from '@medina/auth'
import { NavItem } from './nav-item'
import { ClinicSwitcher } from './clinic-switcher'

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
  )
}

interface SidebarProps {
  clinicSlug: string
  clinics: ClinicSummary[]
  currentClinic: ClinicSummary
}

export function Sidebar({ clinicSlug, clinics, currentClinic }: SidebarProps) {
  const base = `/${clinicSlug}`

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="logo">
        <div className="logo-mark">M</div>
        <div className="logo-text">Medina</div>
      </div>

      {/* Clinic switcher */}
      <ClinicSwitcher clinics={clinics} current={currentClinic} />

      {/* Nav — Operação */}
      <div className="nav-section">
        <div className="nav-label">Operação</div>

        <NavItem href={base} exact>
          <NavIcon>
            <path d="M3 12l2-2 4 4 8-8 4 4" />
          </NavIcon>
          Dashboard
        </NavItem>

        <NavItem href={`${base}/inbox`}>
          <NavIcon>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </NavIcon>
          Conversas
        </NavItem>

        <NavItem href={`${base}/pipeline`}>
          <NavIcon>
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </NavIcon>
          Pipeline
        </NavItem>

        <NavItem href={`${base}/calendar`}>
          <NavIcon>
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </NavIcon>
          Agenda
        </NavItem>

        <NavItem href={`${base}/patients`}>
          <NavIcon>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </NavIcon>
          Pacientes
        </NavItem>
      </div>

      {/* Nav — IA */}
      <div className="nav-section">
        <div className="nav-label">IA</div>

        <NavItem href={`${base}/agent`}>
          <NavIcon>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </NavIcon>
          Configurar agente
        </NavItem>

        <NavItem href={`${base}/knowledge`}>
          <NavIcon>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </NavIcon>
          Base de conhecimento
        </NavItem>
      </div>

      {/* Nav — Conta */}
      <div className="nav-section">
        <div className="nav-label">Conta</div>

        <NavItem href={`${base}/settings`}>
          <NavIcon>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </NavIcon>
          Configurações
        </NavItem>
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/shell/sidebar.tsx
git commit -m "feat: Sidebar server component with all nav sections"
```

---

## Task 6 — Topbar server component

**Files:**
- Create: `apps/web/components/shell/topbar.tsx`

Server Component. Passes `email` down to `UserMenu` (Client).

- [ ] **Step 1: Create the component**

```tsx
// apps/web/components/shell/topbar.tsx
import { UserMenu } from './user-menu'

interface TopbarProps {
  email: string | undefined
}

export function Topbar({ email }: TopbarProps) {
  return (
    <div className="topbar">
      <UserMenu email={email} />
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors (UserMenu import path error is expected until Task 7 creates `[slug]/actions.ts`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/shell/topbar.tsx
git commit -m "feat: Topbar server component"
```

---

## Task 7 — logoutAction server action + directory scaffold

**Files:**
- Create: `apps/web/app/[slug]/actions.ts`
- Create directories: `apps/web/app/[slug]/inbox/`, `pipeline/`, `calendar/`, `patients/`, `settings/`

This unblocks the TypeScript error in `user-menu.tsx`.

- [ ] **Step 1: Create the actions file**

```ts
// apps/web/app/[slug]/actions.ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getSupabaseServerClient } from '@medina/auth'

export async function logoutAction(): Promise<void> {
  const supabase = await getSupabaseServerClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/login')
}
```

- [ ] **Step 2: Typecheck — expect 0 errors now**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors (all `@/app/[slug]/actions` imports now resolve).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/[slug]/actions.ts
git commit -m "feat: logoutAction server action"
```

---

## Task 8 — [slug]/layout.tsx

**Files:**
- Create: `apps/web/app/[slug]/layout.tsx`

The layout is the heart of the shell. It:
1. Calls `getTenantContext()` — reads `x-tenant-slug` set by middleware (no `params` needed)
2. Calls `listUserClinics(supabase)` — pre-loads clinic list for ClinicSwitcher
3. Renders `.app` grid: Sidebar (first column) + flex-column right panel (Topbar + `<main>`)

Next.js 15 requirement: `params` is a `Promise<{slug: string}>` and must be typed even if unused.

- [ ] **Step 1: Create the layout**

```tsx
// apps/web/app/[slug]/layout.tsx
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
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/[slug]/layout.tsx
git commit -m "feat: [slug]/layout.tsx with getTenantContext + listUserClinics shell"
```

---

## Task 9 — Dashboard page ([slug]/page.tsx)

**Files:**
- Create: `apps/web/app/[slug]/page.tsx`

Moves the dashboard from `apps/web/app/page.tsx`. The sidebar + topbar are now in the layout, so this file only renders the **page content** (goes inside `<main>`). Greets user by email prefix, shows clinic name, all stat values are 0, both panels show empty states.

- [ ] **Step 1: Create the page**

```tsx
// apps/web/app/[slug]/page.tsx
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
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/[slug]/page.tsx
git commit -m "feat: dashboard page with real tenant greeting and empty states"
```

---

## Task 10 — Landing page at /

**Files:**
- Modify: `apps/web/app/page.tsx` (replace entirely)

- [ ] **Step 1: Replace page.tsx with landing**

```tsx
// apps/web/app/page.tsx
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
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/page.tsx
git commit -m "feat: minimal landing page at /"
```

---

## Task 11 — Placeholder pages

**Files:**
- Create: `apps/web/app/[slug]/inbox/page.tsx`
- Create: `apps/web/app/[slug]/pipeline/page.tsx`
- Create: `apps/web/app/[slug]/calendar/page.tsx`
- Create: `apps/web/app/[slug]/patients/page.tsx`
- Create: `apps/web/app/[slug]/settings/page.tsx`

All five are identical in structure — one per sub-route.

- [ ] **Step 1: Create inbox placeholder**

```tsx
// apps/web/app/[slug]/inbox/page.tsx
export default function InboxPage() {
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
        Conversas
      </h2>
      <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)' }}>
        Em construção.
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Create pipeline placeholder**

```tsx
// apps/web/app/[slug]/pipeline/page.tsx
export default function PipelinePage() {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', flex: 1, padding: '80px 0', gap: 8,
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--luma-text-primary)' }}>
        Pipeline
      </h2>
      <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)' }}>Em construção.</p>
    </div>
  )
}
```

- [ ] **Step 3: Create calendar placeholder**

```tsx
// apps/web/app/[slug]/calendar/page.tsx
export default function CalendarPage() {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', flex: 1, padding: '80px 0', gap: 8,
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--luma-text-primary)' }}>
        Agenda
      </h2>
      <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)' }}>Em construção.</p>
    </div>
  )
}
```

- [ ] **Step 4: Create patients placeholder**

```tsx
// apps/web/app/[slug]/patients/page.tsx
export default function PatientsPage() {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', flex: 1, padding: '80px 0', gap: 8,
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--luma-text-primary)' }}>
        Pacientes
      </h2>
      <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)' }}>Em construção.</p>
    </div>
  )
}
```

- [ ] **Step 5: Create settings placeholder**

```tsx
// apps/web/app/[slug]/settings/page.tsx
export default function SettingsPage() {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', flex: 1, padding: '80px 0', gap: 8,
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--luma-text-primary)' }}>
        Configurações
      </h2>
      <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)' }}>Em construção.</p>
    </div>
  )
}
```

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @medina/web typecheck
git add apps/web/app/[slug]/inbox/page.tsx apps/web/app/[slug]/pipeline/page.tsx apps/web/app/[slug]/calendar/page.tsx apps/web/app/[slug]/patients/page.tsx apps/web/app/[slug]/settings/page.tsx
git commit -m "feat: placeholder pages for inbox, pipeline, calendar, patients, settings"
```

---

## Task 12 — Typecheck + build + final verification

- [ ] **Step 1: Run full typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Run full build**

```bash
pnpm --filter @medina/web build
```

Expected: Build completes with no TypeScript or compilation errors. Next.js may warn about static page analysis for `[slug]` dynamic routes — that is expected.

- [ ] **Step 3: If Base UI import fails**

If `import { Popover } from '@base-ui/react'` or `import { Menu } from '@base-ui/react'` throw "Module not found" or "has no exported member", check the actual exports:

```bash
node -e "const b = require('./node_modules/@base-ui/react/dist/index.cjs'); console.log(Object.keys(b))"
```

Run from `apps/web/`. Then update the imports in `clinic-switcher.tsx` and `user-menu.tsx` to match.

If `Positioner` doesn't exist on the namespace, it's likely just `Popup` with `sideOffset`/`side` props directly (some v1 builds bundle positioning into `Popup`). Adjust accordingly.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: issue 5 — app shell with tenant-aware layout, sidebar, topbar and user menu"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] A) Plan created at `docs/superpowers/plans/2026-05-02-app-shell.md`
- [x] B) `app/page.tsx` → landing; dashboard moved to `[slug]/page.tsx`
- [x] C) `[slug]/layout.tsx` — Server Component, `await params`, `getTenantContext()`, grid + sidebar + topbar + children in main
- [x] D) `components/shell/sidebar.tsx` — all nav items with correct SVG paths; `ClinicSwitcher` client within
- [x] D) `components/shell/clinic-switcher.tsx` — Popover (Base UI), pre-loaded clinics, `router.push(/<slug>)`
- [x] E) `[slug]/actions.ts` — `logoutAction` with signOut + revalidatePath + redirect('/login')
- [x] F) Placeholder pages for inbox, pipeline, calendar, patients, settings
- [x] G) Dashboard uses `getTenantContext()` for greeting and clinic name; stat values are 0; empty states
- [x] H) Luma tokens used throughout; sidebar 240px, padding 20px 16px, border-right, backdrop-blur; topbar 56px, border-bottom; main padding 24px 32px 48px; stat-cards with Luma shadow + radius 12px + hover lift (from existing CSS)
- [x] I) `<Toaster />` remains in root `app/layout.tsx` — not touched
- [x] J) Typecheck + build in Task 12
- [x] K) Final commit message matches spec

**Potential issues to watch:**
1. Base UI `Popover.Positioner` / `Menu.Positioner` — verify the namespace structure matches v1.4 (Task 12 Step 3 handles this)
2. `Popover.Trigger` as button: the `.clinic-switcher` class uses `display: flex` which overrides `button`'s `text-align: center` naturally — but browser button default `padding` is overridden by the class — should be fine
3. `app/[slug]/actions` import path from `user-menu.tsx` — the `[` and `]` are literal filesystem characters; this is a valid TS module path
4. `getTenantContext()` in both layout AND dashboard page — each call independently reads the `x-tenant-slug` header from the current request. Both are in the same request context, so both succeed without extra DB queries beyond what's needed.
