---
name: schema-migration-checklist
description: Checklist obrigatório quando criar plans/migrations envolvendo SQL, RLS, triggers, ou functions Postgres. Captura riscos sistemáticos identificados em auditoria de issues 8-10.
---

# Schema Migration Checklist

ATIVA SEMPRE que prompt mencionar: migration, schema, RLS, trigger, policy, function SQL, packages/db/migrations/.

## ETAPA 1 — Antes de escrever o plan, LÊ schema existente

Lista o que existe HOJE pra evitar incoerências:
- packages/db/migrations/*.sql — todas migrations aplicadas
- packages/db/src/schema/*.ts — schemas Drizzle
- Especificamente verifica colunas de tabelas referenciadas (audit_logs, clinics, clinic_members, integrations, patients, conversations, messages, etc)

NUNCA inventa nome de coluna. Se incerto, lê migration original.

## ETAPA 2 — Riscos sistemáticos pra prever no plan

### RLS performance (CRÍTICO)
TODA policy que usa auth.uid() DEVE wrappar como (select auth.uid()).
Aplica em USING e WITH CHECK.
Senão: advisor warn auth_rls_initplan + performance ruim em scale.

### Cross-tenant FK validation
Toda FK pra tabela com clinic_id precisa trigger validando que clinic_ids batem.
Validar tanto em INSERT quanto UPDATE.
Múltiplas FKs (patient_id, conversation_id, deal_id) = múltiplos triggers ou um trigger consolidado.

### Trigger BEFORE vs AFTER
- BEFORE: trigger pode MODIFICAR NEW (set_updated_at, set_won_at, set_completed_at, etc)
- AFTER: trigger pode SELECT/INSERT em outras tabelas (audit log, cascade)
- Quando precisa modificar NEW E logar audit: 2 triggers separados (BEFORE pra NEW, AFTER pra audit) OU 1 BEFORE que faz tudo
- Múltiplos triggers BEFORE no mesmo evento: ordem é alfabética por nome do trigger

### SECURITY DEFINER em triggers e funções
Triggers/funções que fazem SELECT em tabelas com RLS habilitada PRECISAM SECURITY DEFINER.
Search_path explícito OBRIGATÓRIO: SET search_path = public, pg_temp.
Senão: trigger falha quando disparado por user com RLS, ou vulnerabilidade de schema hijacking.

### Postgres.js gotchas
- SET command NÃO aceita parâmetros: usar SELECT set_config('key', $1, true)
- Aplica em qualquer função SQL chamada via supabase-js ou postgres-js

### Migration ordering
- Função referenciando tabela: cria tabela ANTES da função
- Helper functions usadas em triggers: criar antes dos triggers que as chamam
- OU usar CREATE OR REPLACE FUNCTION ao final pra contornar forward references

### Audit log com user_id NULL
Quando trigger dispara via service_role: auth.uid() retorna NULL.
audit_logs.user_id deve aceitar NULL (FK ON DELETE SET NULL).
Documenta no plan: "audit user_id é NULL quando ação é via service_role".

## ETAPA 3 — Plan deve ter conteúdo REAL

Plan NÃO PODE conter:
- "see ESCOPO" / "see prompt" / "see issue" como conteúdo de Task
- Placeholders genéricos sem código
- "Create with all tables" sem dizer quais

Plan DEVE conter:
- SQL real das tabelas (com colunas, tipos, constraints)
- SQL real das policies (USING e WITH CHECK reais)
- SQL real dos triggers (BEFORE/AFTER explícito, security definer quando aplicável)
- Nomes reais de colunas (consultados de schemas existentes)
- Casos de teste descritos (não código completo necessariamente, mas o que cada teste valida)

## ETAPA 4 — Self-check antes de aprovar plan

Antes de marcar plan como pronto:
- [ ] Toda policy com auth.uid() usa (select auth.uid())?
- [ ] FKs cross-tenant têm trigger de validação documentado?
- [ ] Triggers BEFORE vs AFTER documentados com razão?
- [ ] Funções SECURITY DEFINER têm search_path explícito?
- [ ] Funções chamadas via supabase-js/postgres-js evitam SET parametrizado?
- [ ] Ordem de criação na migration sem forward references?
- [ ] Audit log preparado pra user_id NULL onde aplicável?
- [ ] Plan tem SQL REAL ou apenas placeholders?
- [ ] Nomes de colunas em testes batem com schema existente (consultou migrations anteriores)?

Se algum item respondeu "não" — corrige antes de continuar.
