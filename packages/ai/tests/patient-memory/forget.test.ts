import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { forgetFacts, loadPatientFacts, upsertFacts, touchFacts } from '../../src/patient-memory/store.js'
import type { ExtractedFact } from '../../src/patient-memory/types.js'

function makeSupabase(opts: {
  rpcResult?: { data: unknown; error: unknown }
  selectResult?: { data: unknown; error: unknown }
  upsertResult?: { data: unknown; error: unknown }
  updateResult?: { data: unknown; error: unknown }
} = {}) {
  const rpc = vi.fn().mockResolvedValue(opts.rpcResult ?? { data: 0, error: null })

  const orderFn = vi.fn().mockResolvedValue(opts.selectResult ?? { data: [], error: null })
  const eqPatient = vi.fn().mockReturnValue({ is: vi.fn().mockReturnValue({ order: orderFn }) })
  const eqClinic = vi.fn().mockReturnValue({ eq: eqPatient })
  const selectFn = vi.fn().mockReturnValue({ eq: eqClinic })

  const upsertFn = vi.fn().mockReturnValue({
    select: vi.fn().mockResolvedValue(opts.upsertResult ?? { data: [], error: null }),
  })
  const inFn = vi.fn().mockResolvedValue(opts.updateResult ?? { data: null, error: null })
  const updateFn = vi.fn().mockReturnValue({ in: inFn })

  const fromFn = vi.fn().mockImplementation((_table: string) => ({
    select: selectFn,
    upsert: upsertFn,
    update: updateFn,
  }))

  return {
    sb: { from: fromFn, rpc } as unknown as SupabaseClient,
    rpc,
    fromFn,
    selectFn,
    eqClinic,
    eqPatient,
    upsertFn,
    updateFn,
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
  it('seleciona apenas facts ativos da clínica + paciente', async () => {
    const now = '2026-05-11T10:00:00.000Z'
    const { sb, fromFn, selectFn, eqClinic, eqPatient } = makeSupabase({
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
  it('chama upsert com onConflict pra (clinic_id, patient_id, category, key)', async () => {
    const { sb, upsertFn } = makeSupabase({
      upsertResult: { data: [{ id: 'fact-1' }], error: null },
    })
    const facts: ExtractedFact[] = [
      { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.9 },
    ]
    await upsertFacts(sb, 'clinic-A', 'pat-1', facts, { conversationId: 'conv-1', messageId: 'msg-1' })
    expect(upsertFn).toHaveBeenCalledTimes(1)
    const args = upsertFn.mock.calls[0]
    expect(args?.[0]).toEqual([
      expect.objectContaining({
        clinic_id: 'clinic-A',
        patient_id: 'pat-1',
        category: 'administrative',
        key: 'preferred_name',
        value: 'Jô',
        confidence: 0.9,
        source_conversation_id: 'conv-1',
        source_message_id: 'msg-1',
      }),
    ])
    expect(args?.[1]).toMatchObject({
      onConflict: 'clinic_id,patient_id,category,key',
    })
  })

  it('quando facts é vazio, não chama supabase e retorna {inserted:0, updated:0}', async () => {
    const { sb, upsertFn } = makeSupabase()
    const r = await upsertFacts(sb, 'clinic-A', 'pat-1', [], { conversationId: 'conv-1' })
    expect(upsertFn).not.toHaveBeenCalled()
    expect(r).toEqual({ inserted: 0, updated: 0 })
  })

  it('propaga erro do supabase', async () => {
    const { sb } = makeSupabase({
      upsertResult: { data: null, error: { message: 'cross-tenant violation' } },
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
  it('UPDATE patient_facts SET last_referenced_at = now() WHERE id IN factIds', async () => {
    const { sb, updateFn, inFn } = makeSupabase()
    await touchFacts(sb, ['fact-1', 'fact-2'])
    expect(updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ last_referenced_at: expect.any(String) })
    )
    expect(inFn).toHaveBeenCalledWith('id', ['fact-1', 'fact-2'])
  })

  it('quando factIds é vazio, não chama supabase', async () => {
    const { sb, updateFn } = makeSupabase()
    await touchFacts(sb, [])
    expect(updateFn).not.toHaveBeenCalled()
  })

  it('silencia erro do supabase (fire-and-forget)', async () => {
    const { sb } = makeSupabase({
      updateResult: { data: null, error: { message: 'transient' } },
    })
    await expect(touchFacts(sb, ['fact-1'])).resolves.toBeUndefined()
  })
})
