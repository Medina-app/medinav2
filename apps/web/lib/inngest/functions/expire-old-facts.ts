import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────

export type ExpireOldFactsDeps = {
  supabase: SupabaseClient;
  batchLimit?: number;
};

export type ExpireOldFactsResult = {
  expired: number;
};

const DEFAULT_BATCH_LIMIT = 1000;

// ─── Handler (testable) ──────────────────────────────────────────────────

/**
 * AI-6: cron mensal que sweepa patient_facts inativos. Política: 6 meses sem
 * reuso (last_referenced_at < now() - 6 months) → soft-delete com
 * forget_reason='expired'. RPC expire_old_patient_facts roda como
 * SECURITY DEFINER e processa em lote (default 1000 rows). Se voltar 1000,
 * provavelmente tem mais — Inngest pode re-disparar manualmente; cron mensal
 * normalmente é mais que suficiente pra volume esperado.
 */
export async function expireOldFactsHandler(
  deps: ExpireOldFactsDeps,
): Promise<ExpireOldFactsResult> {
  const limit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const { data, error } = await deps.supabase.rpc('expire_old_patient_facts', {
    p_batch_limit: limit,
  });
  if (error) {
    throw new Error(`expire-old-facts: ${error.message}`);
  }
  return { expired: typeof data === 'number' ? data : 0 };
}

// ─── Production wiring ───────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function makeDefaultDeps(): ExpireOldFactsDeps {
  return { supabase: makeAdminSupabase() };
}

// ─── Inngest wiring ──────────────────────────────────────────────────────

// Mensal: dia 1 às 03:00 (horário do servidor — Vercel/Inngest usam UTC por
// default; 03:00 UTC = 00:00 BRT, low-traffic).
export const expireOldFacts = inngest.createFunction(
  {
    id: 'expire-old-patient-facts',
    triggers: [{ cron: '0 3 1 * *' }],
  },
  async () => expireOldFactsHandler(makeDefaultDeps()),
);
