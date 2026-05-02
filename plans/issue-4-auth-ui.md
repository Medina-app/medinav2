# Issue 4 -- Auth UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create login, signup, and onboarding Server Action flows with full Luma-styled UI and vitest coverage for all three actions.

**Architecture:** TDD-first -- tests for all three Server Actions are written and confirmed failing before implementation. Each route lives in `apps/web/app/(auth)/` with a shared centered layout (no sidebar). Server Actions live in per-route `actions.ts` files that import from `@medina/auth`. Onboarding uses the admin client (service role) to bootstrap clinic + membership atomically, with cleanup on failure. UI pages are Client Components (`'use client'`) using React 19 `useActionState`; the outer onboarding page is a Server Component that reads the user name.

**Tech Stack:** Next.js 15 App Router, React 19 `useActionState`, Zod (real schemas from `@medina/auth`), sonner toasts, vitest (new setup for `apps/web`), shadcn/ui components (button, input, label), Tailwind v4 Luma tokens

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/web/vitest.config.ts` | vitest -- node env, `@/` alias, setupFiles |
| `apps/web/tests/setup.ts` | Global mocks: `server-only`, `next/headers` |
| `apps/web/tests/actions/login-action.test.ts` | loginAction: Zod invalid, Supabase error mapped, redirect to clinic or /onboarding |
| `apps/web/tests/actions/signup-action.test.ts` | signupAction: Zod invalid, signUp call with full_name, redirect /onboarding |
| `apps/web/tests/actions/onboarding-action.test.ts` | createClinicAction: slug regex, 23505, cleanup on member fail, redirect /<slug> |
| `apps/web/app/(auth)/layout.tsx` | Centered auth layout -- logo + max-w-[400px], no sidebar |
| `apps/web/app/(auth)/login/actions.ts` | `loginAction` Server Action |
| `apps/web/app/(auth)/login/page.tsx` | Login form -- email + password, useActionState + sonner |
| `apps/web/app/(auth)/signup/actions.ts` | `signupAction` Server Action |
| `apps/web/app/(auth)/signup/page.tsx` | Signup form -- name + email + password |
| `apps/web/app/(auth)/onboarding/actions.ts` | `createClinicAction` -- admin client, cleanup on member fail |
| `apps/web/app/(auth)/onboarding/page.tsx` | Server Component: reads user name, renders OnboardingForm |
| `apps/web/app/(auth)/onboarding/onboarding-form.tsx` | Client Component: slug auto-gen from name, form submit |

**Modified files:**

| File | Change |
|------|--------|
| `apps/web/package.json` | Add `vitest`, `@vitejs/plugin-react` to devDependencies; add `"test"` script |

---

### Task 0: Configure vitest in apps/web

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/tests/setup.ts`

- [ ] **Step 1: Update `apps/web/package.json`**

Add `"test": "vitest run"` to `scripts`. Add to `devDependencies`:
```json
"@vitejs/plugin-react": "^4.3.4",
"vitest": "^3.1.3"
```

Final `scripts` and `devDependencies`:
```json
{
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3",
    "@tailwindcss/postcss": "^4",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4.3.4",
    "eslint": "^9",
    "eslint-config-next": "^15",
    "shadcn": "^4.6.0",
    "tailwindcss": "^4",
    "typescript": "^5",
    "vitest": "^3.1.3"
  }
}
```

- [ ] **Step 2: Create `apps/web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
  },
})
```

- [ ] **Step 3: Create `apps/web/tests/setup.ts`**

```ts
import { vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({ get: (_key: string) => null }),
  cookies: vi.fn().mockResolvedValue({
    getAll: () => [],
    get: (_name: string) => undefined,
    set: vi.fn(),
  }),
}))
```

- [ ] **Step 4: Install dependencies**

```
pnpm install
```

Expected: exits 0. `vitest` symlinked in `apps/web/node_modules/.bin/vitest`.

- [ ] **Step 5: Smoke-test the vitest setup**

```
pnpm --filter @medina/web test
```

Expected: "No test files found" or similar -- exits 0.

- [ ] **Step 6: Commit**

```
git add apps/web/package.json apps/web/vitest.config.ts apps/web/tests/setup.ts
git commit -m "chore: add vitest to apps/web"
```

---

### Task 1: loginAction -- TDD

**Files:**
- Create: `apps/web/tests/actions/login-action.test.ts`
- Create: `apps/web/app/(auth)/login/actions.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/tests/actions/login-action.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('@medina/auth')>()
  return {
    ...original,
    getSupabaseServerClient: vi.fn(),
    listUserClinics: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { redirect } from 'next/navigation'
import { getSupabaseServerClient, listUserClinics } from '@medina/auth'
import { loginAction } from '../../app/(auth)/login/actions'

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

const mockSignIn = vi.fn()
const mockSupabase = { auth: { signInWithPassword: mockSignIn } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
})

describe('loginAction', () => {
  it('returns Zod error for invalid email', async () => {
    const state = await loginAction(null, makeFormData({ email: 'not-email', password: '123456' }))
    expect(state).toEqual({ error: 'Email invalido' })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('returns Zod error for short password', async () => {
    const state = await loginAction(null, makeFormData({ email: 'a@b.com', password: '12' }))
    expect(state).toEqual({ error: 'Senha deve ter pelo menos 6 caracteres' })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('returns generic error when Supabase rejects credentials', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } })
    const state = await loginAction(null, makeFormData({ email: 'a@b.com', password: 'validpass' }))
    expect(state).toEqual({ error: 'Email ou senha incorretos' })
  })

  it('redirects to first clinic slug on success', async () => {
    mockSignIn.mockResolvedValue({ data: {}, error: null })
    vi.mocked(listUserClinics).mockResolvedValue([
      { id: '1', slug: 'minha-clinica', name: 'Minha Clinica', role: 'owner' },
    ])
    await loginAction(null, makeFormData({ email: 'a@b.com', password: 'validpass' }))
    expect(redirect).toHaveBeenCalledWith('/minha-clinica')
  })

  it('redirects to /onboarding when user has no clinics', async () => {
    mockSignIn.mockResolvedValue({ data: {}, error: null })
    vi.mocked(listUserClinics).mockResolvedValue([])
    await loginAction(null, makeFormData({ email: 'a@b.com', password: 'validpass' }))
    expect(redirect).toHaveBeenCalledWith('/onboarding')
  })
})
```

NOTE: The error message for invalid email in the Zod schema is `'Email invalido'` (without accent) for the test assertion. In the actual app it is `'Email invalido'` as defined in `packages/auth/src/schemas.ts`. Verify the exact string by reading `packages/auth/src/schemas.ts` line 4 before running tests.

- [ ] **Step 2: Run tests to confirm they fail**

```
pnpm --filter @medina/web test
```

Expected: FAIL -- `Cannot find module '../../app/(auth)/login/actions'`

- [ ] **Step 3: Create `apps/web/app/(auth)/login/actions.ts`**

```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { LoginSchema, getSupabaseServerClient, listUserClinics } from '@medina/auth'

export type LoginState = { error: string } | null

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const result = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!result.success) {
    return { error: result.error.errors[0]?.message ?? 'Dados invalidos' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase.auth.signInWithPassword(result.data)

  if (error) {
    return { error: 'Email ou senha incorretos' }
  }

  const clinics = await listUserClinics(supabase)
  revalidatePath('/', 'layout')

  const first = clinics[0]
  if (first) {
    redirect(`/${first.slug}`)
  }
  redirect('/onboarding')
}
```

- [ ] **Step 4: Run tests -- confirm all pass**

```
pnpm --filter @medina/web test
```

Expected: PASS -- 5 tests in `login-action.test.ts`.

- [ ] **Step 5: Commit**

```
git add apps/web/tests/actions/login-action.test.ts apps/web/app/(auth)/login/actions.ts
git commit -m "feat: loginAction -- Zod validation, error mapping, redirect to clinic or /onboarding"
```

---

### Task 2: signupAction -- TDD

**Files:**
- Create: `apps/web/tests/actions/signup-action.test.ts`
- Create: `apps/web/app/(auth)/signup/actions.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/tests/actions/signup-action.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('@medina/auth')>()
  return {
    ...original,
    getSupabaseServerClient: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import { redirect } from 'next/navigation'
import { getSupabaseServerClient } from '@medina/auth'
import { signupAction } from '../../app/(auth)/signup/actions'

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

const mockSignUp = vi.fn()
const mockSupabase = { auth: { signUp: mockSignUp } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
})

describe('signupAction', () => {
  it('returns Zod error for short name', async () => {
    const state = await signupAction(
      null,
      makeFormData({ name: 'A', email: 'a@b.com', password: 'password123' }),
    )
    expect(state).toEqual({ error: 'Nome deve ter pelo menos 2 caracteres' })
    expect(mockSignUp).not.toHaveBeenCalled()
  })

  it('returns Zod error for invalid email', async () => {
    const state = await signupAction(
      null,
      makeFormData({ name: 'Ana', email: 'not-email', password: 'password123' }),
    )
    expect(state).toEqual({ error: 'Email invalido' })
  })

  it('returns Zod error for short password', async () => {
    const state = await signupAction(
      null,
      makeFormData({ name: 'Ana', email: 'a@b.com', password: 'short' }),
    )
    expect(state).toEqual({ error: 'Senha deve ter pelo menos 8 caracteres' })
  })

  it('returns error message when Supabase signUp fails', async () => {
    mockSignUp.mockResolvedValue({ data: null, error: { message: 'User already registered' } })
    const state = await signupAction(
      null,
      makeFormData({ name: 'Ana', email: 'a@b.com', password: 'password123' }),
    )
    expect(state).toEqual({ error: 'User already registered' })
  })

  it('passes full_name in options.data and redirects to /onboarding on success', async () => {
    mockSignUp.mockResolvedValue({ data: { user: {} }, error: null })
    await signupAction(
      null,
      makeFormData({ name: 'Ana Lima', email: 'ana@b.com', password: 'password123' }),
    )
    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'ana@b.com',
      password: 'password123',
      options: { data: { full_name: 'Ana Lima' } },
    })
    expect(redirect).toHaveBeenCalledWith('/onboarding')
  })
})
```

- [ ] **Step 2: Confirm tests fail**

```
pnpm --filter @medina/web test
```

Expected: FAIL -- `Cannot find module '../../app/(auth)/signup/actions'`

- [ ] **Step 3: Create `apps/web/app/(auth)/signup/actions.ts`**

```ts
'use server'

import { redirect } from 'next/navigation'
import { SignupSchema, getSupabaseServerClient } from '@medina/auth'

export type SignupState = { error: string } | null

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const result = SignupSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!result.success) {
    return { error: result.error.errors[0]?.message ?? 'Dados invalidos' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase.auth.signUp({
    email: result.data.email,
    password: result.data.password,
    options: { data: { full_name: result.data.name } },
  })

  if (error) {
    return { error: error.message }
  }

  redirect('/onboarding')
}
```

- [ ] **Step 4: Confirm tests pass**

```
pnpm --filter @medina/web test
```

Expected: PASS -- 5 tests in `signup-action.test.ts`.

- [ ] **Step 5: Commit**

```
git add apps/web/tests/actions/signup-action.test.ts apps/web/app/(auth)/signup/actions.ts
git commit -m "feat: signupAction -- full_name in options.data, error forwarded, redirect /onboarding"
```

---

### Task 3: createClinicAction -- TDD

**Files:**
- Create: `apps/web/tests/actions/onboarding-action.test.ts`
- Create: `apps/web/app/(auth)/onboarding/actions.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/tests/actions/onboarding-action.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('@medina/auth')>()
  return {
    ...original,
    getSupabaseServerClient: vi.fn(),
    getSupabaseAdminClient: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { redirect } from 'next/navigation'
import { getSupabaseServerClient, getSupabaseAdminClient } from '@medina/auth'
import { createClinicAction } from '../../app/(auth)/onboarding/actions'

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

const mockGetUser = vi.fn()
const mockServerSupabase = { auth: { getUser: mockGetUser } }

type ClinicResult = {
  data: { id: string; slug: string } | null
  error: { message: string; code: string } | null
}
type MemberResult = {
  data: unknown
  error: { message: string; code: string } | null
}

function buildAdmin(clinicResult: ClinicResult, memberResult: MemberResult) {
  const clinicDeleteEq = vi.fn().mockResolvedValue({ data: null, error: null })
  const clinicDeleteFn = vi.fn().mockReturnValue({ eq: clinicDeleteEq })

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'clinics') {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(clinicResult),
          }),
        }),
        delete: clinicDeleteFn,
      }
    }
    if (table === 'clinic_members') {
      return { insert: vi.fn().mockResolvedValue(memberResult) }
    }
  })

  return { admin: { from: fromFn }, clinicDeleteFn, clinicDeleteEq }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockServerSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
})

describe('createClinicAction', () => {
  it('returns Zod error when slug has uppercase letters', async () => {
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clinica', slug: 'MinhaClinica' }),
    )
    expect(state).toEqual({
      error: 'Slug deve conter apenas letras minusculas, numeros e hifens',
    })
  })

  it('returns Zod error when slug is too short', async () => {
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clinica', slug: 'ab' }),
    )
    expect(state).toEqual({ error: 'Slug deve ter pelo menos 3 caracteres' })
  })

  it('maps Postgres 23505 to slug-already-in-use message', async () => {
    const { admin } = buildAdmin(
      { data: null, error: { message: 'duplicate key', code: '23505' } },
      { data: null, error: null },
    )
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clinica', slug: 'minha-clinica' }),
    )
    expect(state).toEqual({ error: 'Este slug ja esta em uso. Escolha outro.' })
  })

  it('deletes clinic and returns error when membership insert fails', async () => {
    const { admin, clinicDeleteFn, clinicDeleteEq } = buildAdmin(
      { data: { id: 'clinic-abc', slug: 'minha-clinica' }, error: null },
      { data: null, error: { message: 'FK error', code: '23503' } },
    )
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clinica', slug: 'minha-clinica' }),
    )

    expect(clinicDeleteFn).toHaveBeenCalled()
    expect(clinicDeleteEq).toHaveBeenCalledWith('id', 'clinic-abc')
    expect(state).toEqual({ error: 'Erro ao configurar clinica. Tente novamente.' })
  })

  it('revalidates and redirects to /<slug> on success', async () => {
    const { admin } = buildAdmin(
      { data: { id: 'clinic-xyz', slug: 'minha-clinica' }, error: null },
      { data: {}, error: null },
    )
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clinica', slug: 'minha-clinica' }),
    )
    expect(redirect).toHaveBeenCalledWith('/minha-clinica')
  })
})
```

NOTE: Error message strings in tests above use ASCII-only (no accents) to avoid encoding issues in this plan file. When writing the actual test file, verify exact Zod messages from `packages/auth/src/schemas.ts` and use the accented versions: `'Email invalido'` -> `'Email inválido'`, `'Slug deve conter apenas letras minusculas, numeros e hifens'` -> `'Slug deve conter apenas letras minúsculas, números e hífens'`, etc.

- [ ] **Step 2: Confirm tests fail**

```
pnpm --filter @medina/web test
```

Expected: FAIL -- `Cannot find module '../../app/(auth)/onboarding/actions'`

- [ ] **Step 3: Create `apps/web/app/(auth)/onboarding/actions.ts`**

```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { CreateClinicSchema, getSupabaseServerClient, getSupabaseAdminClient } from '@medina/auth'

export type OnboardingState = { error: string } | null

export async function createClinicAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const result = CreateClinicSchema.safeParse({
    name: formData.get('name'),
    slug: formData.get('slug'),
  })

  if (!result.success) {
    return { error: result.error.errors[0]?.message ?? 'Dados invalidos' }
  }

  const supabase = await getSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'Sessao expirada. Faca login novamente.' }
  }

  const admin = getSupabaseAdminClient()

  const { data: clinicData, error: clinicError } = await admin
    .from('clinics')
    .insert({ name: result.data.name, slug: result.data.slug })
    .select('id, slug')
    .single()

  if (clinicError || !clinicData) {
    if (clinicError?.code === '23505') {
      return { error: 'Este slug ja esta em uso. Escolha outro.' }
    }
    return { error: 'Erro ao criar clinica. Tente novamente.' }
  }

  const clinic = clinicData as { id: string; slug: string }

  const { error: memberError } = await admin
    .from('clinic_members')
    .insert({ clinic_id: clinic.id, user_id: user.id, role: 'owner' })

  if (memberError) {
    await admin.from('clinics').delete().eq('id', clinic.id)
    return { error: 'Erro ao configurar clinica. Tente novamente.' }
  }

  revalidatePath('/', 'layout')
  redirect(`/${clinic.slug}`)
}
```

NOTE: Replace ASCII-only strings above with proper accented Portuguese when writing the actual file. Check `packages/auth/src/schemas.ts` for exact Zod messages. User-facing strings should use full Portuguese with accents.

- [ ] **Step 4: Confirm all 15 tests pass**

```
pnpm --filter @medina/web test
```

Expected: PASS -- 15 tests (5 login + 5 signup + 5 onboarding).

- [ ] **Step 5: Commit**

```
git add apps/web/tests/actions/onboarding-action.test.ts apps/web/app/(auth)/onboarding/actions.ts
git commit -m "feat: createClinicAction -- 23505 mapping, membership cleanup, redirect /<slug>"
```

---

### Task 4: Auth Layout

**Files:**
- Create: `apps/web/app/(auth)/layout.tsx`

- [ ] **Step 1: Create the auth layout**

Create `apps/web/app/(auth)/layout.tsx`:

```tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 relative z-10">
      <div className="mb-8 flex items-center gap-2.5">
        <div
          className="w-7 h-7 rounded-[8px] flex items-center justify-center text-white text-[13px] font-semibold tracking-tight flex-shrink-0"
          style={{
            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 2px rgba(0,0,0,0.1)',
          }}
        >
          M
        </div>
        <span
          className="font-semibold text-sm tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          Medina
        </span>
      </div>
      <div className="w-full max-w-[400px]">{children}</div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```
git add apps/web/app/(auth)/layout.tsx
git commit -m "feat: (auth) layout -- centered logo + 400px container, no sidebar"
```

---

### Task 5: Login Page UI

**Files:**
- Create: `apps/web/app/(auth)/login/page.tsx`

- [ ] **Step 1: Create `apps/web/app/(auth)/login/page.tsx`**

```tsx
'use client'

import { useActionState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loginAction, type LoginState } from './actions'

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState<LoginState, FormData>(loginAction, null)

  useEffect(() => {
    if (state?.error) {
      toast.error(state.error)
    }
  }, [state])

  return (
    <div
      className="bg-white rounded-[12px] p-8"
      style={{ border: '1px solid var(--luma-border)', boxShadow: 'var(--luma-shadow-hero)' }}
    >
      <div className="mb-6">
        <h1
          className="text-xl font-semibold tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          Entrar
        </h1>
        <p className="text-sm mt-1 tracking-tight" style={{ color: 'var(--luma-text-secondary)' }}>
          Acesse sua conta para continuar
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <div className="space-y-1.5">
          <Label
            htmlFor="email"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="voce@clinica.com"
            autoComplete="email"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="password"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Senha
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            autoComplete="current-password"
            required
          />
        </div>

        <Button
          type="submit"
          disabled={isPending}
          className="w-full h-9 text-sm font-medium tracking-tight text-white border-transparent"
          style={{
            background: 'linear-gradient(180deg, #1a1a1a, #000000)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.1)',
          }}
        >
          {isPending ? 'Entrando...' : 'Entrar'}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs" style={{ color: 'var(--luma-text-tertiary)' }}>
        {'Nao tem conta? '}
        <Link
          href="/signup"
          className="font-medium hover:underline"
          style={{ color: 'var(--luma-accent)' }}
        >
          Criar conta
        </Link>
      </p>
    </div>
  )
}
```

NOTE: Replace `placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"` with `placeholder="••••••••"` in the actual file. The actual file should use UTF-8 bullet characters directly.

- [ ] **Step 2: Commit**

```
git add apps/web/app/(auth)/login/page.tsx
git commit -m "feat: login page -- useActionState + sonner error toast + Luma card"
```

---

### Task 6: Signup Page UI

**Files:**
- Create: `apps/web/app/(auth)/signup/page.tsx`

- [ ] **Step 1: Create `apps/web/app/(auth)/signup/page.tsx`**

```tsx
'use client'

import { useActionState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { signupAction, type SignupState } from './actions'

export default function SignupPage() {
  const [state, formAction, isPending] = useActionState<SignupState, FormData>(signupAction, null)

  useEffect(() => {
    if (state?.error) {
      toast.error(state.error)
    }
  }, [state])

  return (
    <div
      className="bg-white rounded-[12px] p-8"
      style={{ border: '1px solid var(--luma-border)', boxShadow: 'var(--luma-shadow-hero)' }}
    >
      <div className="mb-6">
        <h1
          className="text-xl font-semibold tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          Criar conta
        </h1>
        <p className="text-sm mt-1 tracking-tight" style={{ color: 'var(--luma-text-secondary)' }}>
          Comece agora, gratis
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <div className="space-y-1.5">
          <Label
            htmlFor="name"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Nome completo
          </Label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="Ana Lima"
            autoComplete="name"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="email"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="ana@clinica.com"
            autoComplete="email"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="password"
            className="text-xs font-medium"
            style={{ color: 'var(--luma-text-secondary)' }}
          >
            Senha
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
            autoComplete="new-password"
            required
          />
        </div>

        <Button
          type="submit"
          disabled={isPending}
          className="w-full h-9 text-sm font-medium tracking-tight text-white border-transparent"
          style={{
            background: 'linear-gradient(180deg, #1a1a1a, #000000)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.1)',
          }}
        >
          {isPending ? 'Criando conta...' : 'Criar conta'}
        </Button>
      </form>

      <p className="mt-4 text-center text-xs" style={{ color: 'var(--luma-text-tertiary)' }}>
        {'Ja tem conta? '}
        <Link
          href="/login"
          className="font-medium hover:underline"
          style={{ color: 'var(--luma-accent)' }}
        >
          Entrar
        </Link>
      </p>
    </div>
  )
}
```

NOTE: Replace `placeholder="&bull;..."` with `placeholder="••••••••"` in actual file. Use proper accented Portuguese in user-facing strings: `'Comece agora, grátis'`, `'Já tem conta?'`.

- [ ] **Step 2: Commit**

```
git add apps/web/app/(auth)/signup/page.tsx
git commit -m "feat: signup page -- name + email + password, Luma card style"
```

---

### Task 7: Onboarding Page UI

**Files:**
- Create: `apps/web/app/(auth)/onboarding/page.tsx`
- Create: `apps/web/app/(auth)/onboarding/onboarding-form.tsx`

The page is a Server Component that reads the user's name from Supabase session metadata. The form is a Client Component that auto-generates the slug from the clinic name.

- [ ] **Step 1: Create `apps/web/app/(auth)/onboarding/page.tsx`**

```tsx
import { getSupabaseServerClient } from '@medina/auth'
import { OnboardingForm } from './onboarding-form'

export default async function OnboardingPage() {
  const supabase = await getSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const fullName = user?.user_metadata['full_name'] as string | undefined
  const firstName = fullName?.split(' ')[0] ?? 'voce'

  return (
    <div
      className="bg-white rounded-[12px] p-8"
      style={{ border: '1px solid var(--luma-border)', boxShadow: 'var(--luma-shadow-hero)' }}
    >
      <div className="mb-6">
        <h1
          className="text-xl font-semibold tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          {`Bem-vindo, ${firstName}!`}
        </h1>
        <p className="text-sm mt-1 tracking-tight" style={{ color: 'var(--luma-text-secondary)' }}>
          Vamos criar sua primeira clinica.
        </p>
      </div>
      <OnboardingForm />
    </div>
  )
}
```

NOTE: Replace `'voce'` with `'você'` and `'Vamos criar sua primeira clinica.'` with `'Vamos criar sua primeira clínica.'` in actual file. Plan doc avoids accents to prevent encoding issues.

- [ ] **Step 2: Create `apps/web/app/(auth)/onboarding/onboarding-form.tsx`**

```tsx
'use client'

import { useActionState, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClinicAction, type OnboardingState } from './actions'

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState<OnboardingState, FormData>(
    createClinicAction,
    null,
  )
  const [clinicName, setClinicName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  useEffect(() => {
    if (!slugEdited) setSlug(toSlug(clinicName))
  }, [clinicName, slugEdited])

  useEffect(() => {
    if (state?.error) toast.error(state.error)
  }, [state])

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label
          htmlFor="name"
          className="text-xs font-medium"
          style={{ color: 'var(--luma-text-secondary)' }}
        >
          Nome da clinica
        </Label>
        <Input
          id="name"
          name="name"
          type="text"
          placeholder="Clinica Sao Lucas"
          value={clinicName}
          onChange={(e) => setClinicName(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="slug"
          className="text-xs font-medium"
          style={{ color: 'var(--luma-text-secondary)' }}
        >
          Endereco (slug)
        </Label>
        <div className="flex items-center">
          <span
            className="h-8 px-2.5 flex items-center text-sm rounded-l-lg border border-r-0 select-none shrink-0"
            style={{
              borderColor: 'var(--luma-border-strong)',
              color: 'var(--luma-text-tertiary)',
              backgroundColor: 'var(--luma-bg-subtle)',
            }}
          >
            medina.app/
          </span>
          <Input
            id="slug"
            name="slug"
            type="text"
            placeholder="clinica-sao-lucas"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            className="rounded-l-none"
            required
          />
        </div>
        <p className="text-xs" style={{ color: 'var(--luma-text-tertiary)' }}>
          Apenas letras minusculas, numeros e hifens.
        </p>
      </div>

      <Button
        type="submit"
        disabled={isPending}
        className="w-full h-9 text-sm font-medium tracking-tight text-white border-transparent"
        style={{
          background: 'linear-gradient(180deg, #1a1a1a, #000000)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.1)',
        }}
      >
        {isPending ? 'Criando clinica...' : 'Criar clinica'}
      </Button>
    </form>
  )
}
```

NOTE: Use proper Portuguese with accents in actual file: `'Nome da clínica'`, `'Endereço (slug)'`, `'Apenas letras minúsculas, números e hífens.'`, `'Criando clínica...'`, `'Criar clínica'`, `'Clínica São Lucas'`.

- [ ] **Step 3: Commit**

```
git add apps/web/app/(auth)/onboarding/page.tsx apps/web/app/(auth)/onboarding/onboarding-form.tsx
git commit -m "feat: onboarding page -- welcome + slug auto-gen client form"
```

---

### Task 8: Install missing shadcn component

**Files:**
- New: `apps/web/components/ui/alert.tsx` (created by shadcn CLI)

Note: button, input, label, card, sonner are already present in `apps/web/components/ui/`. Only `alert` is missing.

- [ ] **Step 1: Install alert**

```
pnpm --filter @medina/web exec shadcn add alert
```

Expected: `apps/web/components/ui/alert.tsx` created.

- [ ] **Step 2: Commit**

```
git add apps/web/components/ui/alert.tsx
git commit -m "chore: add shadcn alert component"
```

---

### Task 9: Typecheck + Build + All tests

- [ ] **Step 1: Run all 15 tests**

```
pnpm --filter @medina/web test
```

Expected: PASS -- 15 tests across 3 files. If any fail, read the error, fix the relevant file, re-run.

- [ ] **Step 2: Run typecheck**

```
pnpm --filter @medina/web typecheck
```

Expected: no errors. Common issues to fix:
- `user_metadata` access: `user.user_metadata['full_name'] as string | undefined` -- works with noUncheckedIndexedAccess since user_metadata is `Record<string, unknown>`.
- Array index access: `errors[0]?.message` -- the `?.` handles the undefined case; final `?? 'Dados invalidos'` is the fallback.
- `clinicData` cast: `clinicData as { id: string; slug: string }` -- needed because Supabase client has no DB type params.

- [ ] **Step 3: Run build**

```
pnpm --filter @medina/web build
```

Expected: successful Next.js build. If build fails on a page:
- Check that `'use server'` is the literal first line of each `actions.ts` (no blank lines or imports before it).
- Check that `onboarding/page.tsx` has no `'use client'` -- it is a Server Component.

- [ ] **Step 4: Fix any errors before proceeding to final commit**

Do not use `any` or `@ts-ignore`. In test files, `as unknown as X` is the accepted TypeScript pattern for mock objects.

---

### Task 10: Final commit

- [ ] **Step 1: Confirm working tree**

```
git status
```

All action files, page files, tests, and config files should be committed. Verify no `.env*.local` file is staged.

- [ ] **Step 2: Final commit**

```
git add -A
git commit -m "feat: issue 4 - auth UI with login, signup and onboarding flows"
```
