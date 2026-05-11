import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractPatientFactsHandler,
  type ExtractPatientFactsDeps,
  type ExtractPatientFactsEvent,
} from '../extract-patient-facts';

type AiMemoryMetadata = {
  ai_memory?: { enabled?: boolean; categories?: string[] };
};

type Conversation = {
  id: string;
  clinic_id: string;
  patient_id: string | null;
};

function makeSupabase(opts: {
  clinicMetadata?: AiMemoryMetadata | null;
  conversation?: Conversation | null;
  history?: Array<{ content: string | null; sender_type: string; created_at: string }>;
  existingFacts?: Array<Record<string, unknown>>;
  upsertRpcResult?: { inserted: number; updated: number };
} = {}) {
  const clinicSingle = vi.fn().mockResolvedValue({
    data: opts.clinicMetadata !== undefined ? { metadata: opts.clinicMetadata } : null,
    error: opts.clinicMetadata !== undefined ? null : { message: 'not found' },
  });
  const clinicEq = vi.fn().mockReturnValue({ single: clinicSingle });
  const clinicSelect = vi.fn().mockReturnValue({ eq: clinicEq });

  const convSingle = vi.fn().mockResolvedValue({
    data: opts.conversation ?? null,
    error: opts.conversation ? null : { message: 'not found' },
  });
  const convEq = vi.fn().mockReturnValue({ single: convSingle });
  const convSelect = vi.fn().mockReturnValue({ eq: convEq });

  const historyLimit = vi.fn().mockResolvedValue({
    data: opts.history ?? [],
    error: null,
  });
  const historyOrder = vi.fn().mockReturnValue({ limit: historyLimit });
  const historyEq = vi.fn().mockReturnValue({ order: historyOrder });

  // patient_facts.select (loadPatientFacts) chain:
  // .eq('clinic_id', X).eq('patient_id', Y).is('deleted_at', null).order(...)
  const factsOrder = vi.fn().mockResolvedValue({
    data: opts.existingFacts ?? [],
    error: null,
  });
  const factsIs = vi.fn().mockReturnValue({ order: factsOrder });
  const factsEqPatient = vi.fn().mockReturnValue({ is: factsIs });
  const factsEqClinic = vi.fn().mockReturnValue({ eq: factsEqPatient });
  const factsSelect = vi.fn().mockReturnValue({ eq: factsEqClinic });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'clinics') return { select: clinicSelect };
    if (table === 'conversations') return { select: convSelect };
    if (table === 'messages') return { select: vi.fn().mockReturnValue({ eq: historyEq }) };
    if (table === 'patient_facts') return { select: factsSelect };
    throw new Error(`unmocked table: ${table}`);
  });

  const rpc = vi.fn().mockResolvedValue({
    data: opts.upsertRpcResult ?? { inserted: 0, updated: 0 },
    error: null,
  });

  return {
    sb: { from, rpc } as unknown as SupabaseClient,
    spies: { from, rpc, historyLimit, convSingle, clinicSingle, factsOrder },
  };
}

const baseEvent: ExtractPatientFactsEvent = {
  data: {
    conversationId: 'conv-1',
    clinicId: 'clinic-A',
    trigger: 'escalated',
  },
};

function makeDeps(
  sb: SupabaseClient,
  extractorReturns: Awaited<ReturnType<ExtractPatientFactsDeps['extractor']>> = [],
): ExtractPatientFactsDeps {
  return {
    supabase: sb,
    extractor: vi.fn().mockResolvedValue(extractorReturns),
  };
}

describe('extractPatientFactsHandler', () => {
  it('skipped:memory_disabled quando ai_memory.enabled=false', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: false, categories: ['administrative'] } },
    });
    const deps = makeDeps(sb);
    const result = await extractPatientFactsHandler(baseEvent, deps);
    expect(result).toEqual({ skipped: 'memory_disabled' });
    expect(deps.extractor).not.toHaveBeenCalled();
  });

  it('skipped:memory_disabled quando metadata.ai_memory ausente', async () => {
    const { sb } = makeSupabase({ clinicMetadata: {} });
    const deps = makeDeps(sb);
    const result = await extractPatientFactsHandler(baseEvent, deps);
    expect(result).toEqual({ skipped: 'memory_disabled' });
  });

  it('skipped:no_categories quando enabled=true mas categories=[]', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: [] } },
    });
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb));
    expect(result).toEqual({ skipped: 'no_categories' });
  });

  it('skipped:conversation_not_found quando conversa não existe', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: ['administrative'] } },
      conversation: null,
    });
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb));
    expect(result).toEqual({ skipped: 'conversation_not_found' });
  });

  it('skipped:cross_tenant quando conversa pertence a outra clínica', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: ['administrative'] } },
      conversation: { id: 'conv-1', clinic_id: 'clinic-OTHER', patient_id: 'pat-1' },
    });
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb));
    expect(result).toEqual({ skipped: 'cross_tenant' });
  });

  it('skipped:no_patient_linked quando conversa não tem patient_id', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: ['administrative'] } },
      conversation: { id: 'conv-1', clinic_id: 'clinic-A', patient_id: null },
    });
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb));
    expect(result).toEqual({ skipped: 'no_patient_linked' });
  });

  it('skipped:no_messages quando histórico vazio', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: ['administrative'] } },
      conversation: { id: 'conv-1', clinic_id: 'clinic-A', patient_id: 'pat-1' },
      history: [],
    });
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb));
    expect(result).toEqual({ skipped: 'no_messages' });
  });

  it('chama extractor com categorias habilitadas + persiste facts via RPC upsert_patient_facts', async () => {
    const { sb, spies } = makeSupabase({
      clinicMetadata: {
        ai_memory: { enabled: true, categories: ['administrative', 'financial'] },
      },
      conversation: { id: 'conv-1', clinic_id: 'clinic-A', patient_id: 'pat-1' },
      history: [
        { content: 'meu nome é João', sender_type: 'patient', created_at: '2026-05-11T10:00:00Z' },
      ],
      upsertRpcResult: { inserted: 1, updated: 0 },
    });
    const facts = [
      { category: 'administrative' as const, key: 'preferred_name', value: 'João', confidence: 0.9 },
    ];
    const deps = makeDeps(sb, facts);

    const result = await extractPatientFactsHandler(baseEvent, deps);

    expect(deps.extractor).toHaveBeenCalledWith(
      expect.objectContaining({
        categories: expect.any(Set),
      }),
    );
    const args = (deps.extractor as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      categories: Set<string>;
    };
    expect(args.categories.has('administrative')).toBe(true);
    expect(args.categories.has('financial')).toBe(true);

    expect(spies.rpc).toHaveBeenCalledWith(
      'upsert_patient_facts',
      expect.objectContaining({
        p_clinic_id: 'clinic-A',
        p_patient_id: 'pat-1',
        p_source_conversation_id: 'conv-1',
      }),
    );
    expect(result).toEqual({ inserted: 1, updated: 0, total: 1 });
  });

  it('detecta updated quando RPC retorna updated > 0 (mesma category,key)', async () => {
    const now = '2026-05-11T10:00:00Z';
    const { sb } = makeSupabase({
      clinicMetadata: {
        ai_memory: { enabled: true, categories: ['administrative'] },
      },
      conversation: { id: 'conv-1', clinic_id: 'clinic-A', patient_id: 'pat-1' },
      history: [{ content: 'me chame de João', sender_type: 'patient', created_at: now }],
      upsertRpcResult: { inserted: 0, updated: 1 },
    });
    const facts = [
      { category: 'administrative' as const, key: 'preferred_name', value: 'João', confidence: 0.95 },
    ];
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb, facts));
    expect(result).toEqual({ inserted: 0, updated: 1, total: 1 });
  });

  it('extractor retornando [] resulta em upsert no-op (sem chamar RPC)', async () => {
    const { sb, spies } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: ['administrative'] } },
      conversation: { id: 'conv-1', clinic_id: 'clinic-A', patient_id: 'pat-1' },
      history: [{ content: 'oi', sender_type: 'patient', created_at: '2026-05-11T10:00:00Z' }],
    });
    const result = await extractPatientFactsHandler(baseEvent, makeDeps(sb, []));
    expect(spies.rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ inserted: 0, updated: 0, total: 0 });
  });

  it('throws quando clinics lookup falha (clinic não existe)', async () => {
    const { sb } = makeSupabase({ clinicMetadata: undefined });
    await expect(
      extractPatientFactsHandler(baseEvent, makeDeps(sb)),
    ).rejects.toThrow(/clinic lookup failed/i);
  });

  it('throws quando load de messages retorna erro (Inngest retries)', async () => {
    const { sb } = makeSupabase({
      clinicMetadata: { ai_memory: { enabled: true, categories: ['administrative'] } },
      conversation: { id: 'conv-1', clinic_id: 'clinic-A', patient_id: 'pat-1' },
    });
    // Override só messages.select pra retornar erro.
    const orig = (sb as unknown as { from: ReturnType<typeof vi.fn> }).from;
    ;(sb as unknown as { from: ReturnType<typeof vi.fn> }).from = vi
      .fn()
      .mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'rls denied' } }),
                }),
              }),
            }),
          };
        }
        return orig(table);
      });
    await expect(
      extractPatientFactsHandler(baseEvent, makeDeps(sb)),
    ).rejects.toThrow(/rls denied/i);
  });
})
