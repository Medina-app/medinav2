import { describe, it, expect } from 'vitest'
import { buildCollectInfoTool, ALLOWED_FIELDS } from '../../src/tools/collect-info.js'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

type ExecResult = { ok: boolean; field?: string; instruction?: string }

interface ToolWithExecute {
  execute: (input: { field: string }) => Promise<ExecResult>
  inputSchema: { safeParse: (v: unknown) => { success: boolean } }
}

const asTool = (t: unknown) => t as ToolWithExecute

describe('collect_patient_info', () => {
  it.each(ALLOWED_FIELDS)('accepts allowed field: %s', async (field) => {
    const mock = buildMockSupabase({
      conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } },
    })
    const result = await asTool(
      buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })),
    ).execute({ field })

    expect(result.ok).toBe(true)
    expect(result.field).toBe(field)
    expect(result.instruction).toBeDefined()
    expect((result.instruction as string).length).toBeGreaterThan(5)
  })

  it('rejects unknown field via Zod (does not call DB)', () => {
    const tool = asTool(buildCollectInfoTool(buildToolContext()))
    expect(tool.inputSchema.safeParse({ field: 'cpf' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ field: 'name' }).success).toBe(true)
  })

  it('chama RPC collect_info_atomic com args corretos (#12 atomic refactor)', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } },
    })
    await asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ field: 'name' })

    // Tool agora delega read-modify-write pra RPC (nao mais update direto).
    expect(mock.rpc).toHaveBeenCalledWith(
      'collect_info_atomic',
      expect.objectContaining({
        p_conversation_id: 'conv-1',
        p_clinic_id: 'clinic-A',
        p_field: 'name',
      }),
    )
    // p_value é ISO timestamp gerado no momento da chamada.
    const rpcArgs = mock.rpc.mock.calls[0]?.[1] as { p_value: string }
    expect(rpcArgs.p_value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('lanca quando RPC retorna error (cross-tenant ou conversa nao encontrada)', async () => {
    const mock = buildMockSupabase(
      { conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } } },
      { data: null, error: { message: 'cross-tenant violation' } },
    )
    await expect(
      asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
        .execute({ field: 'name' }),
    ).rejects.toThrow(/cross-tenant violation/)
  })

  it('lanca quando audit_logs insert falha (CR review #2: nao silenciar)', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } },
      audit_logs: { insertError: { message: 'audit table down' } },
    })
    await expect(
      asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
        .execute({ field: 'name' }),
    ).rejects.toThrow(/audit_logs insert failed: audit table down/)
  })

  it('returns instruction in Portuguese for the LLM (not preempting patient response)', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } },
    })
    const r = await asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ field: 'name' })
    expect(r.instruction).toMatch(/peça|pergunte|nome/i)
  })

  it('writes audit_logs entry action=agent.tool.collect_info', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } },
    })
    await asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ field: 'reason' })

    const audit = mock.insertCalls.find((c) => c.table === 'audit_logs')
    expect(audit).toBeDefined()
    expect(audit!.payload).toMatchObject({
      action: 'agent.tool.collect_info',
      resource: 'conversations',
      user_id: null,
    })
    expect((audit!.payload as { metadata: { field: string } }).metadata.field).toBe('reason')
  })
})
