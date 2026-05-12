-- 0036_clinics_default_agent_name.sql
--
-- Issue PR-E GH #8 (AI-1 follow-up): support multiple agent_config names.
-- Antes: dispatchAgent + createAgent aceitavam `agentName?` param defaultando
-- pra 'agente-principal', mas NENHUM caller em produção passava diferente
-- (apps/web/lib/inngest/functions/dispatch-ai-agent.ts:74 omite). Resultado
-- efetivo: sistema single-agent apesar da infra multi-agent.
--
-- Fix: per-clinic default via coluna em clinics. NOT NULL DEFAULT
-- 'agente-principal' — back-compat com clinics existentes (PostgreSQL
-- preenche todas as rows com o default atomicamente). Dispatcher lê
-- clinics.default_agent_name como fallback quando args.agentName não é
-- provido; override explícito via args.agentName (futuro: routing
-- per-conversation) ainda vence.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS default_agent_name TEXT NOT NULL DEFAULT 'agente-principal';

COMMENT ON COLUMN public.clinics.default_agent_name IS
  'Nome do agent_config que dispatcher usa por padrão pra esta clinic. Deve corresponder a um agent_configs.name com status=published na mesma clinic. Default "agente-principal".';
