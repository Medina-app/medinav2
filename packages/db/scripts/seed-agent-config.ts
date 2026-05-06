/**
 * Seeds a default 'agente-principal' agent_config for a clinic.
 * Idempotent: re-running for a clinic that already has a published
 * agent_config with name='agente-principal' returns the existing id.
 *
 * Run via:
 *   pnpm tsx packages/db/scripts/seed-agent-config.ts <clinic-id>
 *
 * Reads from process.env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Source the worktree's apps/web/.env.local (or set the vars inline) before invoking.
 */
import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT_TEMPLATE = `Você é o assistente virtual da clínica médica {{clinic_name}}.
Responda de forma educada, profissional e acolhedora aos pacientes via WhatsApp.

Diretrizes:
- Cumprimente o paciente pelo nome quando souber.
- Seja conciso (máximo 3 parágrafos por resposta).
- NÃO dê diagnósticos médicos. NÃO recomende medicamentos.
- Para dúvidas técnicas/clínicas, oriente o paciente a falar com um humano da equipe.

FERRAMENTAS DISPONÍVEIS (use quando apropriado):
- escalate_to_human(reason): use quando o paciente pede um médico, descreve uma urgência, está irritado, ou a questão está fora do seu escopo. Após escalar, despeça-se brevemente em uma frase curta — não tente continuar resolvendo.
- check_business_hours(): SEMPRE chame antes de propor agendamento imediato ou afirmar que a clínica está aberta. Não invente disponibilidade. Use o resultado pra responder com precisão (e.g., "estamos fechados agora, podemos agendar pra amanhã às 8h").
- collect_patient_info(field): chame quando precisar de uma informação estruturada (name, age, reason, phone_alt). A tool retorna a instrução — você deve fazer a pergunta no próximo turno.
`;

const DEFAULT_TOOLS = [
  'escalate_to_human',
  'check_business_hours',
  'collect_patient_info',
];

export interface SeedResult {
  created: boolean;
  configId: string;
  clinicName: string;
}

export async function seedDefaultAgentConfig(clinicId: string): Promise<SeedResult> {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !serviceKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: clinic, error: cErr } = await sb
    .from('clinics')
    .select('name')
    .eq('id', clinicId)
    .single();
  if (cErr || !clinic) {
    throw new Error(`clinic ${clinicId} not found: ${cErr?.message ?? 'no rows'}`);
  }
  const clinicName = (clinic as { name: string }).name;

  const { data: existing, error: lookupErr } = await sb
    .from('agent_configs')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('name', 'agente-principal')
    .eq('status', 'published')
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`existing agent lookup failed: ${lookupErr.message}`);
  }
  if (existing) {
    return { created: false, configId: (existing as { id: string }).id, clinicName };
  }

  const { data, error } = await sb
    .from('agent_configs')
    .insert({
      clinic_id: clinicId,
      name: 'agente-principal',
      // version is auto-set by trigger auto_set_agent_version() (0009_agent_ai.sql)
      status: 'published',
      system_prompt: SYSTEM_PROMPT_TEMPLATE.replace('{{clinic_name}}', clinicName),
      model: 'anthropic/claude-sonnet-4-5',
      temperature: 0.7,
      max_tokens: 800,
      tools: DEFAULT_TOOLS,
      guardrails: {},
      handoff_rules: {},
      knowledge_document_ids: [],
      metadata: {
        seeded_by: 'packages/db/scripts/seed-agent-config.ts',
        seeded_at: new Date().toISOString(),
      },
      published_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`seed failed: ${error?.message ?? 'unknown'}`);
  }

  return { created: true, configId: (data as { id: string }).id, clinicName };
}

// CLI entry point: only runs when this file is executed directly via tsx.
// argv[1] on Windows uses backslashes + drive letter; import.meta.url is a
// file:// URL with forward slashes. Compare normalized basenames instead.
const invokedAs = process.argv[1] ?? '';
const isMain = invokedAs.endsWith('seed-agent-config.ts') || invokedAs.endsWith('seed-agent-config.js');
if (isMain) {
  const clinicId = process.argv[2];
  if (!clinicId) {
    console.error('Usage: pnpm tsx packages/db/scripts/seed-agent-config.ts <clinic-id>');
    process.exit(1);
  }
  seedDefaultAgentConfig(clinicId)
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
