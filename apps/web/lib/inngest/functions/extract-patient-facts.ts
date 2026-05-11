import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createFactsExtractor,
  loadPatientFacts,
  upsertFacts,
  parseAiMemoryConfig,
  type FactsExtractor,
  type FactCategory,
} from '@medina/ai';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────

export type ExtractPatientFactsEvent = {
  data: {
    conversationId: string;
    clinicId: string;
    /** Why this extract was requested: 'escalated' | 'resolved' | 'manual'. */
    trigger?: string;
  };
};

export type ExtractPatientFactsDeps = {
  supabase: SupabaseClient;
  extractor: FactsExtractor;
};

export type ExtractPatientFactsResult =
  | { inserted: number; updated: number; total: number }
  | {
      skipped:
        | 'memory_disabled'
        | 'no_categories'
        | 'no_patient_linked'
        | 'no_messages'
        | 'cross_tenant'
        | 'conversation_not_found';
    };

const MESSAGES_LOOKBACK = 50;

// ─── Handler (testable) ──────────────────────────────────────────────────

export async function extractPatientFactsHandler(
  event: ExtractPatientFactsEvent,
  deps: ExtractPatientFactsDeps,
): Promise<ExtractPatientFactsResult> {
  const { conversationId, clinicId } = event.data;
  const { supabase, extractor } = deps;

  // 1. Load clinic.metadata.ai_memory config.
  const { data: clinic, error: clinicErr } = await supabase
    .from('clinics')
    .select('metadata')
    .eq('id', clinicId)
    .single();
  if (clinicErr || !clinic) {
    throw new Error(`extract-patient-facts: clinic lookup failed: ${clinicErr?.message ?? 'not found'}`);
  }
  const memoryConfig = parseAiMemoryConfig(
    (clinic as { metadata?: { ai_memory?: unknown } }).metadata?.ai_memory,
  );
  if (!memoryConfig.enabled) {
    return { skipped: 'memory_disabled' };
  }
  if (memoryConfig.categories.length === 0) {
    return { skipped: 'no_categories' };
  }

  // 2. Load conversation + verify clinic ownership + patient_id.
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('id, clinic_id, patient_id')
    .eq('id', conversationId)
    .single();
  if (convErr || !conv) {
    return { skipped: 'conversation_not_found' };
  }
  if (conv.clinic_id !== clinicId) {
    return { skipped: 'cross_tenant' };
  }
  if (!conv.patient_id) {
    return { skipped: 'no_patient_linked' };
  }

  // 3. Load last N messages, oldest-first.
  const { data: rawHistory, error: hErr } = await supabase
    .from('messages')
    .select('content, sender_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(MESSAGES_LOOKBACK);
  if (hErr) {
    throw new Error(`extract-patient-facts: messages load failed: ${hErr.message}`);
  }

  const messages = (rawHistory ?? [])
    .slice()
    .reverse()
    .map((m) => ({
      role: m.sender_type === 'patient' ? ('user' as const) : ('assistant' as const),
      content: (m.content as string | null) ?? '',
    }))
    .filter((m) => m.content.trim().length > 0);

  if (messages.length === 0) {
    return { skipped: 'no_messages' };
  }

  // 4. Extract via Haiku. Whitelist + blocklist already enforced inside extractor.
  const enabledCategories = new Set<FactCategory>(memoryConfig.categories);
  const facts = await extractor({ messages, categories: enabledCategories });

  // 5. Capture pre-state to differentiate inserted vs updated.
  const before = await loadPatientFacts(supabase, clinicId, conv.patient_id);
  const beforeKeys = new Set(before.map((f) => `${f.category}::${f.key}`));

  const { inserted } = await upsertFacts(supabase, clinicId, conv.patient_id, facts, {
    conversationId,
  });

  const updated = facts.filter((f) => beforeKeys.has(`${f.category}::${f.key}`)).length;
  const newlyInserted = Math.max(inserted - updated, 0);

  return { inserted: newlyInserted, updated, total: facts.length };
}

// ─── Production wiring ───────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function makeDefaultDeps(): ExtractPatientFactsDeps {
  return {
    supabase: makeAdminSupabase(),
    extractor: createFactsExtractor(),
  };
}

// ─── Inngest wiring ──────────────────────────────────────────────────────

export const extractPatientFacts = inngest.createFunction(
  {
    id: 'extract-patient-facts',
    retries: 2,
    triggers: [{ event: 'ai/patient-facts.extract-requested' }],
  },
  async ({ event }) =>
    extractPatientFactsHandler(
      event as unknown as ExtractPatientFactsEvent,
      makeDefaultDeps(),
    ),
);
