import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { forgetFacts, loadPatientFacts, upsertFacts, touchFacts } from '../../src/patient-memory/store.js'
import type { ExtractedFact } from '../../src/patient-memory/types.js'

function makeSupabase(opts: {
  rpcResult?: { data: unknown; error: unknown }
  selectResult?: { data: unknown; error: unknown }
  upsertRpcResult?: { data: unknown; error: unknown }
  updateResult?: { data: unknown; error: unknown }
} = {}) {
  // Both forget_patient_facts and upsert_patient_facts go through .rpc().
  // Caller picks which result via mockResolvedValueOnce — but for tests that
  // only call one of them, opts.rpcResult covers both paths. For tests that
  // need different results, use opts.upsertRpcResult to override the next call.
  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === 'upsert_patient_facts' && opts.upsertRpcResult !== undefined) {
      return Promise.resolve(opts.upsertRpcResult)
    }
    return Promise.resolve(opts.rpcResult ?? { data: 0, error: null })
  })

  // loadPatientFacts chain: .select().eq().eq().is().order('category').order('key')
  // The terminal .order() resolves with the data; the first .order() returns
  // a builder that exposes another .order(). Both calls share the same handler.
  const orderKeyFn = vi.fn().mockResolvedValue(opts.selectResult ?? { data: [], error: null })
  const orderCategoryFn = vi.fn().mockReturnValue({ order: orderKeyFn })
  const isDeletedFn = vi.fn().mockReturnValue({ order: orderCategoryFn })
  const eqPatient = vi.fn().mockReturnValue({ is: isDeletedFn })
  const eqClinic = vi.fn().mockReturnValue({ eq: eqPatient })
  const selectFn = vi.fn().mockReturnValue({ eq: eqClinic })

  const inFn = vi.fn().mockResolvedValue(opts.updateResult ?? { data: null, error: null })
  // touchFacts chain: .update(...).eq('clinic_id', X).in('id', factIds)
  const updateEqFn = vi.fn().mockReturnValue({ in: inFn })
  const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn })

  const fromFn = vi.fn().mockImplementation((_table: string) => ({
    select: selectFn,
    update: updateFn,
  }))

  return {
    sb: { from: fromFn, rpc } as unknown as SupabaseClient,
    rpc,
    fromFn,
    selectFn,
    eqClinic,
    eqPatient,
    isDeletedFn,
    orderCategoryFn,
    orderKeyFn,
    updateFn,
    updateEqFn,
    inFn,
  }
}

describe('AI-6: forgetFacts', () => {
  it('chama RPC forget_patient_facts com p_patient_id + p_category + p_reason', async () => {
    const { sb, rpc } = makeSupabase({ rpcResult: { data: 2, error: null } })
    const count = await forgetFacts(sb, 'pat-1', 'administrative', 'user_request')
    expect(rpc).toHaveBeenCalledWith('forget_patient_facts', {
      p_patient_id: 'pat-1',
      p_category: 'administrative',
      p_reason: 'user_request',
    })
    expect(count).toBe(2)
  })

  it('quando category omitida, passa p_category=null pra apagar todas', async () => {
    const { sb, rpc } = makeSupabase({ rpcResult: { data: 5, error: null } })
    await forgetFacts(sb, 'pat-1')
    expect(rpc).toHaveBeenCalledWith('forget_patient_facts', {
      p_patient_id: 'pat-1',
      p_category: null,
      p_reason: 'user_request',
    })
  })

  it('propaga erro do RPC (ex: access denied via non-admin role)', async () => {
    const { sb } = makeSupabase({
      rpcResult: { data: null, error: { message: 'access denied: requires admin or owner role' } },
    })
    await expect(forgetFacts(sb, 'pat-1')).rejects.toThrow(/access denied/i)
  })

  it('reason padrão é user_request', async () => {
    const { sb, rpc } = makeSupabase({ rpcResult: { data: 1, error: null } })
    await forgetFacts(sb, 'pat-1', 'financial')
    expect(rpc).toHaveBeenCalledWith(
      'forget_patient_facts',
      expect.objectContaining({ p_reason: 'user_request' })
    )
  })

  it('admin_delete é reason válido alternativo', async () => {
    const { sb, rpc } = makeSupabase({ rpcResult: { data: 1, error: null } })
    await forgetFacts(sb, 'pat-1', undefined, 'admin_delete')
    expect(rpc).toHaveBeenCalledWith(
      'forget_patient_facts',
      expect.objectContaining({ p_reason: 'admin_delete' })
    )
  })
})

describe('AI-6: loadPatientFacts', () => {
  it('seleciona apenas facts ativos da clínica + paciente (deleted_at IS NULL filter)', async () => {
    const now = '2026-05-11T10:00:00.000Z'
    const { sb, fromFn, selectFn, eqClinic, eqPatient, isDeletedFn, orderCategoryFn, orderKeyFn } = makeSupabase({
      selectResult: {
        data: [
          {
            id: 'fact-1',
            clinic_id: 'clinic-A',
            patient_id: 'pat-1',
            category: 'administrative',
            key: 'preferred_name',
            value: 'Jô',
            confidence: '0.95',
            source_conversation_id: null,
            source_message_id: null,
            last_referenced_at: now,
            created_at: now,
            updated_at: now,
          },
        ],
        error: null,
      },
    })
    const facts = await loadPatientFacts(sb, 'clinic-A', 'pat-1')
    expect(fromFn).toHaveBeenCalledWith('patient_facts')
    expect(selectFn).toHaveBeenCalled()
    expect(eqClinic).toHaveBeenCalledWith('clinic_id', 'clinic-A')
    expect(eqPatient).toHaveBeenCalledWith('patient_id', 'pat-1')
    // CodeRabbit nitpick: garante que o soft-delete filter é aplicado — se removido,
    // facts esquecidos vazariam pro dispatcher/inbox.
    expect(isDeletedFn).toHaveBeenCalledWith('deleted_at', null)
    // CodeRabbit round 3 nitpick: garante ordenação determinística category → key.
    // Se a segunda .order() for removida, este assert quebra.
    expect(orderCategoryFn).toHaveBeenCalledWith('category', { ascending: true })
    expect(orderKeyFn).toHaveBeenCalledWith('key', { ascending: true })
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      id: 'fact-1',
      key: 'preferred_name',
      value: 'Jô',
      confidence: 0.95,
    })
  })

  it('retorna array vazio quando paciente não tem facts', async () => {
    const { sb } = makeSupabase({ selectResult: { data: [], error: null } })
    const facts = await loadPatientFacts(sb, 'clinic-A', 'pat-1')
    expect(facts).toEqual([])
  })

  it('lança quando RLS bloqueia / supabase retorna erro', async () => {
    const { sb } = makeSupabase({
      selectResult: { data: null, error: { message: 'rls denied' } },
    })
    await expect(loadPatientFacts(sb, 'clinic-A', 'pat-1')).rejects.toThrow(/rls denied/i)
  })
})

describe('AI-6: upsertFacts', () => {
  it('chama RPC upsert_patient_facts com clinic + patient + source + facts jsonb', async () => {
    const { sb, rpc } = makeSupabase({
      upsertRpcResult: { data: { inserted: 1, updated: 0 }, error: null },
    })
    const facts: ExtractedFact[] = [
      { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.9 },
    ]
    const result = await upsertFacts(sb, 'clinic-A', 'pat-1', facts, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
    })
    expect(rpc).toHaveBeenCalledWith('upsert_patient_facts', {
      p_clinic_id: 'clinic-A',
      p_patient_id: 'pat-1',
      p_source_conversation_id: 'conv-1',
      p_source_message_id: 'msg-1',
      p_facts: [
        {
          category: 'administrative',
          key: 'preferred_name',
          value: 'Jô',
          confidence: 0.9,
        },
      ],
    })
    expect(result).toEqual({ inserted: 1, updated: 0 })
  })

  it('quando facts é vazio, não chama RPC e retorna {inserted:0, updated:0}', async () => {
    const { sb, rpc } = makeSupabase()
    const r = await upsertFacts(sb, 'clinic-A', 'pat-1', [], { conversationId: 'conv-1' })
    expect(rpc).not.toHaveBeenCalled()
    expect(r).toEqual({ inserted: 0, updated: 0 })
  })

  it('messageId opcional → p_source_message_id passa como null', async () => {
    const { sb, rpc } = makeSupabase({
      upsertRpcResult: { data: { inserted: 1, updated: 0 }, error: null },
    })
    await upsertFacts(
      sb,
      'clinic-A',
      'pat-1',
      [{ category: 'administrative', key: 'preferred_name', value: 'X', confidence: 0.9 }],
      { conversationId: 'conv-1' },
    )
    expect(rpc).toHaveBeenCalledWith(
      'upsert_patient_facts',
      expect.objectContaining({ p_source_message_id: null }),
    )
  })

  it('detecta inserted vs updated via xmax (RPC retorna ambos counts)', async () => {
    const { sb } = makeSupabase({
      upsertRpcResult: { data: { inserted: 2, updated: 3 }, error: null },
    })
    const facts: ExtractedFact[] = [
      { category: 'administrative', key: 'preferred_name', value: 'A', confidence: 0.9 },
    ]
    const result = await upsertFacts(sb, 'clinic-A', 'pat-1', facts, { conversationId: 'conv-1' })
    expect(result).toEqual({ inserted: 2, updated: 3 })
  })

  it('propaga erro do RPC (ex: cross-tenant trigger violation)', async () => {
    const { sb } = makeSupabase({
      upsertRpcResult: { data: null, error: { message: 'cross-tenant violation' } },
    })
    await expect(
      upsertFacts(
        sb,
        'clinic-A',
        'pat-1',
        [{ category: 'administrative', key: 'preferred_name', value: 'X', confidence: 0.9 }],
        { conversationId: 'conv-1' }
      )
    ).rejects.toThrow(/cross-tenant/i)
  })
})

describe('AI-6: touchFacts (fire-and-forget last_referenced_at update)', () => {
  it('UPDATE com clinic_id scope + id IN factIds (defense in depth cross-tenant)', async () => {
    const { sb, updateFn, updateEqFn, inFn } = makeSupabase()
    await touchFacts(sb, 'clinic-A', ['fact-1', 'fact-2'])
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ last_referenced_at: expect.any(String) })
    )
    expect(updateEqFn).toHaveBeenCalledWith('clinic_id', 'clinic-A')
    expect(inFn).toHaveBeenCalledWith('id', ['fact-1', 'fact-2'])
  })

  it('quando factIds é vazio, não chama supabase', async () => {
    const { sb, updateFn } = makeSupabase()
    await touchFacts(sb, 'clinic-A', [])
    expect(updateFn).not.toHaveBeenCalled()
  })

  it('silencia erro do supabase (fire-and-forget)', async () => {
    const { sb } = makeSupabase({
      updateResult: { data: null, error: { message: 'transient' } },
    })
    await expect(touchFacts(sb, 'clinic-A', ['fact-1'])).resolves.toBeUndefined()
  })
})
