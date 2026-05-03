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
- **Nunca inventar tokens. Sempre extrair do HTML de referência.**

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

## Custom skill obrigatória pra schemas

Quando criar/modificar migrations, trigger, policy ou função SQL: ATIVA schema-migration-checklist.
Esse checklist captura patterns recorrentes identificados em auditoria.
Skill em .claude/skills/schema-migration-checklist/SKILL.md.
