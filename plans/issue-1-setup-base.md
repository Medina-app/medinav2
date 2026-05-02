# Issue 1 — Medina Monorepo Base Setup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the Medina monorepo (Turborepo + Next.js 15 App Router) with Tailwind v4, shadcn/ui, Geist Sans font, and a visual identity pixel-faithful to `docs/design-reference.html` — bege background, noise texture, radial color glow, full Luma token system.

**Architecture:** Turborepo monorepo with `apps/web` as the sole Next.js 15 App Router application. CSS tokens use dual namespace: `--luma-*` in `:root` (for `var()` usage) and `--color-luma-*` / `--radius-luma-*` in Tailwind v4 `@theme` (for utility classes like `bg-luma-bg`). shadcn uses its own `--background` / `--foreground` namespace — zero collision. Visual effects are extracted verbatim from the HTML reference and applied via `body::before` (noise) and `body::after` (glow).

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript 5 strict, Tailwind v4 + `@tailwindcss/postcss`, shadcn/ui, Geist Sans, pnpm workspaces, Turborepo 2

---

## Luma Design System — Token Analysis

> Extracted verbatim from `docs/design-reference.html`. Do not invent values.

### Aesthetic Direction (frontend-design analysis)

**Tone:** Refined SaaS minimalism — Linear × Vercel × Luma. Restrained elegance, every detail deliberate.

**What makes it NOT AI-slop:**
- Background is warm bege `#fafafa`, not pure white `#ffffff`
- SVG fractal noise at 40% opacity (real, not CSS filter)
- Geist — Vercel's purpose-built font with OpenType features `ss01 cv11 cv05`
- Tracking: heading h1 at `-0.035em` (editorial authority, not default)
- Radial glow: orange + teal + purple at 8–12% opacity (depth, not decoration)
- Accent: sky blue `#0ea5e9`, not purple gradient

**Comparable products:** Linear (tight nav + dark CTA), Vercel (bege + noise), Stripe (information density), Luma (warmth + glassmorphism sidebar)

### Color Tokens (`:root` → `--luma-*`)

| HTML var | Value | `--luma-*` name |
|---|---|---|
| `--bg` | `#fafafa` | `--luma-bg` |
| `--bg-card` | `#ffffff` | `--luma-bg-card` |
| `--bg-subtle` | `#f5f5f5` | `--luma-bg-subtle` |
| `--text-primary` | `#0a0a0a` | `--luma-text-primary` |
| `--text-secondary` | `#525252` | `--luma-text-secondary` |
| `--text-tertiary` | `#a3a3a3` | `--luma-text-tertiary` |
| `--border` | `rgba(0,0,0,0.06)` | `--luma-border` |
| `--border-strong` | `rgba(0,0,0,0.1)` | `--luma-border-strong` |
| `--accent` | `#0ea5e9` | `--luma-accent` |
| `--accent-soft` | `rgba(14,165,233,0.08)` | `--luma-accent-soft` |
| `--success` | `#10b981` | `--luma-success` |
| `--warning` | `#f59e0b` | `--luma-warning` |
| `--danger` | `#ef4444` | `--luma-danger` |

### Radius Tokens

| HTML var | Value | `--luma-*` name |
|---|---|---|
| `--radius-sm` | `8px` | `--luma-radius-sm` |
| `--radius-md` | `12px` | `--luma-radius-md` |
| `--radius-lg` | `16px` | `--luma-radius-lg` |
| `--radius-xl` | `20px` | `--luma-radius-xl` |

### Shadow System (3 levels extracted from HTML)

```
base:  0 1px 2px rgba(0,0,0,0.02), 0 4px 12px rgba(0,0,0,0.03)
hover: 0 1px 2px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.06)
hero:  0 1px 2px rgba(0,0,0,0.03), 0 8px 24px rgba(0,0,0,0.04)
```

### Typography System

- Font: `'Geist', -apple-system, BlinkMacSystemFont, sans-serif`
- OpenType: `font-feature-settings: "ss01", "cv11", "cv05"`
- Rendering: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`
- `h1` (.page-title): `font-size: 24px; font-weight: 600; letter-spacing: -0.035em`
- `h2` (.hero-text h2): `letter-spacing: -0.025em`
- `h3` (.panel-title): `letter-spacing: -0.015em`
- nav items: `letter-spacing: -0.005em`

### Background System (3 layers)

1. **Base** — `body { background-color: #fafafa }`
2. **Noise** — `body::before` — SVG fractalNoise, `opacity: 0.4`, `mix-blend-mode: multiply`, `z-index: 1`, fixed
3. **Glow** — `body::after` — 3 radial gradients, `filter: blur(40px)`, `z-index: 0`, `top: -200px`, 1200×600px

### Noise SVG (verbatim — do not alter a single character)

```
url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.4'/%3E%3C/svg%3E")
```

### Glow Gradients (verbatim from HTML)

```css
radial-gradient(ellipse 50% 50% at 30% 50%, rgba(251, 146, 60, 0.12), transparent),
radial-gradient(ellipse 50% 50% at 70% 50%, rgba(14, 165, 233, 0.10), transparent),
radial-gradient(ellipse 40% 40% at 50% 30%, rgba(168, 85, 247, 0.08), transparent)
```

---

## Architecture Decisions

**A — Tailwind v4 @theme dual namespace**
- `@theme { --color-luma-bg: #fafafa; }` → generates `bg-luma-bg`, `text-luma-text-primary` etc.
- `:root { --luma-bg: #fafafa; }` → enables `var(--luma-bg)` in arbitrary CSS
- Both hold identical values. No duplication of meaning.

**B — shadcn coexistence (lição aprendida)**
- shadcn uses `--background`, `--foreground`, `--primary` etc. in `@layer base`
- Our `--luma-*` prefix = zero name collision guaranteed
- `body { background-color: var(--luma-bg); }` outside any layer overrides shadcn's `@apply bg-background` (which is in `@layer base`, lower specificity)
- Map shadcn's `--background` to `0 0% 98.04%` (≈ #fafafa in HSL) so even shadcn-native components blend with bege bg

**C — Geist via npm package**
- `pnpm --filter @medina/web add geist`
- Import `GeistSans` from `geist/font/sans` in `layout.tsx`
- Add `GeistSans.variable` class to `<html>` → exposes `--font-geist-sans` CSS variable
- In `globals.css @theme`: `--font-sans: var(--font-geist-sans), -apple-system, ...`

**D — z-index layering**
- `body::after` (glow): `z-index: 0` — behind everything
- `body::before` (noise): `z-index: 1` — above glow
- Page content: `z-index: 2` via `relative z-10` on main wrapper

**E — shadcn init strategy (Windows safe)**
- Install as devDep: `pnpm --filter @medina/web add -D shadcn`
- Init: `pnpm --filter @medina/web exec shadcn init -d --force`
- Add components: `pnpm --filter @medina/web exec shadcn add button input label card sonner`
- Post-init: write final globals.css that includes both shadcn vars AND full Luma system

---

## File Map

### Root
| File | Responsibility |
|---|---|
| `package.json` | Workspace root, turbo scripts, devDeps |
| `pnpm-workspace.yaml` | Declares `apps/*` and `packages/*` |
| `turbo.json` | Pipeline tasks: dev, build, lint, typecheck, test |
| `tsconfig.json` | Base strict TypeScript (ES2022, noUncheckedIndexedAccess) |
| `.gitignore` | Covers node_modules, .next, .turbo, .env*.local, .claude/settings.local.json |
| `.env.example` | Placeholder vars for Supabase + app |
| `CLAUDE.md` | Project docs (max 60 lines) |
| `.coderabbit.yaml` | Basic PR review config |

### apps/web
| File | Responsibility |
|---|---|
| `apps/web/package.json` | @medina/web, next/react/zod deps |
| `apps/web/next.config.ts` | Minimal Next.js config |
| `apps/web/tsconfig.json` | Extends root, adds DOM lib, jsx, paths @/* |
| `apps/web/postcss.config.mjs` | Tailwind v4 PostCSS plugin |
| `apps/web/eslint.config.mjs` | next/core-web-vitals flat config |
| `apps/web/app/globals.css` | **CRITICAL** — full Luma @theme + :root + body effects |
| `apps/web/app/layout.tsx` | GeistSans variable font, html lang=pt-BR, Toaster |
| `apps/web/app/page.tsx` | Hero — "Medina" h1 + subtitle, centered |

---

## Tasks

### Task 1: Root monorepo scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1.1 — Create `package.json`**

```json
{
  "name": "medina",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "prettier --write \"**/*.{ts,tsx,js,jsx,json,md,css}\" --ignore-path .gitignore"
  },
  "devDependencies": {
    "turbo": "^2",
    "prettier": "^3",
    "typescript": "^5"
  },
  "packageManager": "pnpm@9"
}
```

- [ ] **Step 1.2 — Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 1.3 — Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^lint"]
    },
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 1.4 — Create `tsconfig.json` (base, estrito)**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 1.5 — Create `.gitignore`**

```
# Dependencies
node_modules
.pnpm-store

# Build
.next
.turbo
dist
out

# Env
.env
.env.local
.env.*.local

# Claude Code
.claude/settings.local.json

# OS
.DS_Store
Thumbs.db

# Logs
*.log
```

- [ ] **Step 1.6 — Create `.env.example`**

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Database
DATABASE_URL=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=Medina
```

---

### Task 2: apps/web package config

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/eslint.config.mjs`

- [ ] **Step 2.1 — Create `apps/web/package.json`**

```json
{
  "name": "@medina/web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19",
    "zod": "^3"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4",
    "@tailwindcss/postcss": "^4",
    "eslint": "^9",
    "eslint-config-next": "^15",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2.2 — Create `apps/web/next.config.ts`**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

- [ ] **Step 2.3 — Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "noEmit": true,
    "paths": {
      "@/*": ["./*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 2.4 — Create `apps/web/postcss.config.mjs`**

```js
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

- [ ] **Step 2.5 — Create `apps/web/eslint.config.mjs`**

```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [...compat.extends("next/core-web-vitals")];

export default eslintConfig;
```

---

### Task 3: Initial source files (pre-shadcn)

**Files:**
- Create: `apps/web/app/globals.css` (minimal — full version written in Task 7)
- Create: `apps/web/app/layout.tsx` (sem Toaster — adicionado em Task 7)
- Create: `apps/web/app/page.tsx`

- [ ] **Step 3.1 — Create `apps/web/app/globals.css` (minimal)**

```css
@import "tailwindcss";
```

- [ ] **Step 3.2 — Create `apps/web/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Medina",
  description: "CRM para clínicas médicas",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={GeistSans.variable}>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 3.3 — Create `apps/web/app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-8xl font-semibold tracking-tighter" style={{ color: "var(--luma-text-primary)" }}>
          Medina
        </h1>
        <p className="mt-4 text-[15px] font-normal" style={{ color: "var(--luma-text-secondary)", letterSpacing: "-0.01em" }}>
          CRM para clínicas médicas
        </p>
      </div>
    </main>
  );
}
```

---

### Task 4: pnpm install

- [ ] **Step 4.1 — Instalar tudo a partir da raiz**

```bash
pnpm install
```

Expected: Sem erros, `pnpm-lock.yaml` criado, `node_modules` aparece na raiz e em `apps/web/node_modules`.

---

### Task 5: Instalar Geist

- [ ] **Step 5.1 — Adicionar geist ao apps/web**

```bash
pnpm --filter @medina/web add geist
```

Expected: `"geist": "^..."` aparece em `apps/web/package.json` dependencies.

---

### Task 6: shadcn setup

**Files (criados pelo shadcn):**
- Create: `apps/web/components.json`
- Create: `apps/web/lib/utils.ts`
- Create: `apps/web/components/ui/button.tsx`
- Create: `apps/web/components/ui/input.tsx`
- Create: `apps/web/components/ui/label.tsx`
- Create: `apps/web/components/ui/card.tsx`
- Create: `apps/web/components/ui/sonner.tsx`

- [ ] **Step 6.1 — Instalar shadcn como devDep (evita pnpm dlx que falha no Windows)**

```bash
pnpm --filter @medina/web add -D shadcn
```

- [ ] **Step 6.2 — Inicializar shadcn**

```bash
pnpm --filter @medina/web exec shadcn init -d --force
```

Expected: Cria `apps/web/components.json`, `apps/web/lib/utils.ts`, modifica `apps/web/app/globals.css`.

Se pedir interação: Style = Default, Base color = Neutral, CSS variables = Yes.

- [ ] **Step 6.3 — Adicionar components**

```bash
pnpm --filter @medina/web exec shadcn add button input label card sonner
```

Expected: Cria `apps/web/components/ui/{button,input,label,card,sonner}.tsx`.

---

### Task 7: globals.css completo com Luma + layout com Toaster

Esta é a etapa mais crítica. shadcn já modificou `globals.css` — agora escrevemos a versão final com o sistema Luma completo.

**Files:**
- Overwrite: `apps/web/app/globals.css`
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 7.1 — Escrever `apps/web/app/globals.css` final**

```css
@import "tailwindcss";

/* ═══════════════════════════════════════════════
   LUMA DESIGN SYSTEM — Tailwind v4 @theme
   Generates utilities: bg-luma-bg, text-luma-text-primary,
   rounded-luma-sm, etc.
   ═══════════════════════════════════════════════ */
@theme {
  --color-luma-bg: #fafafa;
  --color-luma-bg-card: #ffffff;
  --color-luma-bg-subtle: #f5f5f5;
  --color-luma-text-primary: #0a0a0a;
  --color-luma-text-secondary: #525252;
  --color-luma-text-tertiary: #a3a3a3;
  --color-luma-accent: #0ea5e9;
  --color-luma-accent-soft: rgba(14, 165, 233, 0.08);
  --color-luma-success: #10b981;
  --color-luma-warning: #f59e0b;
  --color-luma-danger: #ef4444;

  --radius-luma-sm: 8px;
  --radius-luma-md: 12px;
  --radius-luma-lg: 16px;
  --radius-luma-xl: 20px;

  --font-sans: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, sans-serif;
}

/* ═══════════════════════════════════════════════
   SHADCN CSS VARS
   Namespace separado de --luma-*. Não renomear.
   shadcn components dependem destes tokens.
   Mapeados para valores Luma onde faz sentido.
   ═══════════════════════════════════════════════ */
@layer base {
  :root {
    --background: 0 0% 98.04%;       /* #fafafa — alinhado com --luma-bg */
    --foreground: 0 0% 3.92%;        /* #0a0a0a — alinhado com --luma-text-primary */
    --card: 0 0% 100%;
    --card-foreground: 0 0% 3.92%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 3.92%;
    --primary: 0 0% 9%;
    --primary-foreground: 0 0% 98%;
    --secondary: 0 0% 96.08%;
    --secondary-foreground: 0 0% 9%;
    --muted: 0 0% 96.08%;
    --muted-foreground: 0 0% 45.1%;
    --accent: 0 0% 96.08%;
    --accent-foreground: 0 0% 9%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 89.8%;
    --input: 0 0% 89.8%;
    --ring: 0 0% 3.9%;
    --radius: 0.5rem;
  }
}

/* ═══════════════════════════════════════════════
   LUMA DIRECT VARS — para var() inline e CSS arbitrário
   ═══════════════════════════════════════════════ */
:root {
  --luma-bg: #fafafa;
  --luma-bg-card: #ffffff;
  --luma-bg-subtle: #f5f5f5;
  --luma-text-primary: #0a0a0a;
  --luma-text-secondary: #525252;
  --luma-text-tertiary: #a3a3a3;
  --luma-border: rgba(0, 0, 0, 0.06);
  --luma-border-strong: rgba(0, 0, 0, 0.1);
  --luma-accent: #0ea5e9;
  --luma-accent-soft: rgba(14, 165, 233, 0.08);
  --luma-success: #10b981;
  --luma-warning: #f59e0b;
  --luma-danger: #ef4444;
  --luma-radius-sm: 8px;
  --luma-radius-md: 12px;
  --luma-radius-lg: 16px;
  --luma-radius-xl: 20px;
  --luma-shadow-base: 0 1px 2px rgba(0, 0, 0, 0.02), 0 4px 12px rgba(0, 0, 0, 0.03);
  --luma-shadow-hover: 0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 20px rgba(0, 0, 0, 0.06);
  --luma-shadow-hero: 0 1px 2px rgba(0, 0, 0, 0.03), 0 8px 24px rgba(0, 0, 0, 0.04);
}

/* ═══════════════════════════════════════════════
   BODY — bege + Geist + antialiased
   Fora de @layer base → overrides shadcn's bg-background
   ═══════════════════════════════════════════════ */
body {
  background-color: var(--luma-bg);
  color: var(--luma-text-primary);
  font-family: var(--font-sans);
  font-feature-settings: "ss01", "cv11", "cv05";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
}

/* ═══════════════════════════════════════════════
   NOISE TEXTURE (verbatim de docs/design-reference.html)
   SVG fractalNoise, opacity 0.4, mix-blend-mode multiply
   ═══════════════════════════════════════════════ */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  opacity: 0.4;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.4'/%3E%3C/svg%3E");
  mix-blend-mode: multiply;
}

/* ═══════════════════════════════════════════════
   GLOW RADIAL (verbatim de docs/design-reference.html)
   Laranja (fb923c 12%) + Teal (0ea5e9 10%) + Roxo (a855f7 8%)
   top: -200px, width: 1200px, height: 600px, blur: 40px
   ═══════════════════════════════════════════════ */
body::after {
  content: '';
  position: fixed;
  top: -200px;
  left: 50%;
  transform: translateX(-50%);
  width: 1200px;
  height: 600px;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(ellipse 50% 50% at 30% 50%, rgba(251, 146, 60, 0.12), transparent),
    radial-gradient(ellipse 50% 50% at 70% 50%, rgba(14, 165, 233, 0.10), transparent),
    radial-gradient(ellipse 40% 40% at 50% 30%, rgba(168, 85, 247, 0.08), transparent);
  filter: blur(40px);
}

/* ═══════════════════════════════════════════════
   TIPOGRAFIA — tracking extraído do HTML
   ═══════════════════════════════════════════════ */
h1 {
  font-weight: 600;
  letter-spacing: -0.035em;
}

h2 {
  font-weight: 600;
  letter-spacing: -0.025em;
}

h3 {
  font-weight: 500;
  letter-spacing: -0.02em;
}

h4 {
  font-weight: 500;
  letter-spacing: -0.015em;
}
```

- [ ] **Step 7.2 — Atualizar `apps/web/app/layout.tsx` com Toaster**

```tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Medina",
  description: "CRM para clínicas médicas",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={GeistSans.variable}>
      <body>
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
```

---

### Task 8: CLAUDE.md + .coderabbit.yaml

- [ ] **Step 8.1 — Create `CLAUDE.md`**

```markdown
# Medina

CRM multi-tenant para clínicas médicas. Gerencia pacientes, conversas via WhatsApp, agendamentos e automações com IA.

## Stack

- **Frontend**: Next.js 15 App Router · TypeScript estrito · Tailwind v4 · shadcn/ui · Geist Sans
- **Backend**: Supabase (auth + Postgres + realtime) · SQL puro como source of truth
- **Monorepo**: pnpm workspaces + Turborepo
- **Infra**: Vercel (web) · Supabase (dados)

## Identidade Visual

Estilo Luma — definido em `docs/design-reference.html`. Referência obrigatória.
- Background bege `#fafafa` + noise SVG + glow radial (laranja + teal + roxo)
- Tokens: `--luma-*` em `:root` · `--color-luma-*` em Tailwind `@theme`
- shadcn coexiste via namespace próprio (`--background`, `--foreground`)
- **Nunca inventar tokens. Sempre extrair do HTML.**

## Multi-tenant

Toda tabela tem `clinic_id UUID NOT NULL`. RLS ativo em todas as tabelas.
Tenant resolver via Supabase session + claim `clinic_id`. Zero cross-tenant data.

## Regras

- TypeScript estrito — sem `any`, sem `@ts-ignore`
- PRs < 600 linhas de diff (exceto scaffolding inicial)
- Testes obrigatórios em lógica de negócio e funções puras
- `noUncheckedIndexedAccess` ativo — tratar todos os array accesses
- SQL puro source of truth do schema (migrations manuais, sem ORM schema)

## Workflow

- Branches: `<inicial>/<slug>` → quando Linear existir: `<inicial>/MED-42-slug`
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Nunca commitar `.env*.local` ou `.claude/settings.local.json`

## Skills Ativas (fundação)

`writing-plans` · `frontend-design` · `verification-before-completion` · `test-driven-development`
```

- [ ] **Step 8.2 — Create `.coderabbit.yaml`**

```yaml
language: "pt-BR"
reviews:
  profile: "chill"
  request_changes_workflow: true
  high_level_summary: true
  poem: false
  review_status: true
  collapse_walkthrough: false
  auto_review:
    enabled: true
    drafts: false
```

---

### Task 9: Validação (verification-before-completion)

- [ ] **Step 9.1 — pnpm install**

```bash
pnpm install
```

Expected: Zero erros.

- [ ] **Step 9.2 — Typecheck**

```bash
pnpm --filter @medina/web typecheck
```

Expected: Exit 0, zero erros TypeScript.

- [ ] **Step 9.3 — Build**

```bash
pnpm --filter @medina/web build
```

Expected: `✓ Compiled successfully` ou equivalente. Zero erros.

- [ ] **Step 9.4 — Dev server**

```bash
pnpm --filter @medina/web dev
```

Expected: `▲ Next.js ... ready on http://localhost:3000`

- [ ] **Step 9.5 — Comparação visual**

Abre `http://localhost:3000` e compara com `docs/design-reference.html`:

| Critério | Esperado | Status |
|---|---|---|
| Background bege `#fafafa` | Fundo visivelmente diferente de branco puro | — |
| Noise texture | Granulação sutil visível sobre o fundo | — |
| Glow radial no topo | Tint laranja-teal-roxo difuso na parte superior | — |
| Geist + tracking | Texto com tracking apertado (não padrão) | — |
| h1 "Medina" impactante | Grande, bold, centralizado | — |
| Subtitle muted | "CRM para clínicas médicas" em cinza, menor | — |
| Centralizado | Conteúdo no centro vertical e horizontal | — |

Se qualquer critério falhar → NÃO marcar completo. Ajustar CSS e re-verificar.

---

## Self-Review

**Spec coverage:**
- ✅ A — Root monorepo: Tasks 1 + 4
- ✅ B — apps/web scaffold: Tasks 2 + 3 + 5
- ✅ C — Luma globals.css: Task 7.1
- ✅ D — shadcn: Tasks 6 + 7.2
- ✅ E — CLAUDE.md: Task 8.1
- ✅ F — .coderabbit.yaml: Task 8.2
- ✅ Validation: Task 9

**Placeholder scan:** Nenhum TBD, TODO ou placeholder encontrado. Todos os steps têm código real.

**Type consistency:**
- `GeistSans` importado de `geist/font/sans` em Tasks 3.2 e 7.2 — mesmo módulo
- `@/components/ui/sonner` em Task 7.2 — criado pelo shadcn em Task 6.3
- `--luma-*` vars usadas em `page.tsx` (Task 3.3) — definidas em `globals.css` (Task 7.1)
