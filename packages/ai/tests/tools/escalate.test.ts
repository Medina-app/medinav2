import { describe, it, expect } from 'vitest'
import { buildEscalateTool } from '../../src/tools/escalate.js'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

type ExecResult = { ok: boolean; error?: string; message?: string }

interface ToolWithExecute {
  execute: (input: { reason: string }) => Promise<ExecResult>
  inputSchema: { safeParse: (v: unknown) => { success: boolean } }
}

function asTool(t: unknown): ToolWithExecute {
  return t as ToolWithExecute
}

describe('escalate_to_human', () => {
  it('transitions ai_handling → waiting_human via RPC with reason', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { id: 'conv-1', state: 'ai_handling', clinic_id: 'clinic-A' } },
    })
    const tool = asTool(buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ reason: 'paciente com urgência médica' })

    expect(result.ok).toBe(true)
    expect(mock.rpc).toHaveBeenCalledWith('transition_conversation_state', {
      conv_id: 'conv-1',
      new_state: 'waiting_human',
      reason: 'agent_escalated:paciente com urgência médica',
    })
  })

  it('inserts system message with sender_type=system and content_type=system', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { id: 'conv-1', state: 'ai_handling', clinic_id: 'clinic-A' } },
    })
    await asTool(buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ reason: 'urgência' })

    const msgInsert = mock.insertCalls.find((c) => c.table === 'messages')
    expect(msgInsert).toBeDefined()
    expect(msgInsert!.payload).toMatchObject({
      clinic_id: 'clinic-A',
      conversation_id: 'conv-1',
      direction: 'outbound',
      sender_type: 'system',
      content_type: 'system',
    })
    expect((msgInsert!.payload as { content: string }).content).toContain('urgência')
  })

  it('rejects when conversation belongs to different clinic (cross-tenant)', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { id: 'conv-1', state: 'ai_handling', clinic_id: 'clinic-OTHER' } },
    })
    const ctx = buildToolContext({ supabase: mock.supabase as never, clinicId: 'clinic-A' })

    await expect(
      asTool(buildEscalateTool(ctx)).execute({ reason: 'paciente nervoso' }),
    ).rejects.toThrow(/cross-tenant/i)

    expect(mock.rpc).not.toHaveBeenCalled()
  })

  it('returns idempotent error when already waiting_human (no RPC, no inserts)', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { id: 'conv-1', state: 'waiting_human', clinic_id: 'clinic-A' } },
    })
    const result = await asTool(
      buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })),
    ).execute({ reason: 'urgência' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('já_transferida')
    expect(mock.rpc).not.toHaveBeenCalled()
    expect(mock.insertCalls).toHaveLength(0)
  })

  it('writes audit_logs row with action=agent.tool.escalate and user_id=null', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { id: 'conv-1', state: 'ai_handling', clinic_id: 'clinic-A' } },
    })
    await asTool(buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ reason: 'paciente irritado' })

    const auditInsert = mock.insertCalls.find((c) => c.table === 'audit_logs')
    expect(auditInsert).toBeDefined()
    expect(auditInsert!.payload).toMatchObject({
      clinic_id: 'clinic-A',
      user_id: null,
      action: 'agent.tool.escalate',
      resource: 'conversations',
      resource_id: 'conv-1',
    })
    expect((auditInsert!.payload as { metadata: { reason: string } }).metadata.reason).toBe(
      'paciente irritado',
    )
  })

  it('Zod validates reason min length', () => {
    const tool = asTool(buildEscalateTool(buildToolContext()))
    expect(tool.inputSchema.safeParse({ reason: 'x' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ reason: 'paciente irritado' }).success).toBe(true)
  })
})
