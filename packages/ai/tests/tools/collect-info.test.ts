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

  it('marks conversation.metadata.collected_info[field] with ISO timestamp', async () => {
    const mock = buildMockSupabase({
      conversations: { single: { metadata: {}, clinic_id: 'clinic-A' } },
    })
    await asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ field: 'name' })

    const update = mock.updateCalls.find((c) => c.table === 'conversations')
    expect(update).toBeDefined()
    const md = (update!.payload as { metadata: { collected_info: Record<string, string> } }).metadata
    expect(md.collected_info).toBeDefined()
    expect(md.collected_info.name).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('preserves existing metadata when adding collected_info', async () => {
    const mock = buildMockSupabase({
      conversations: {
        single: {
          metadata: { existing_key: 'preserve_me', collected_info: { reason: '2026-01-01T00:00:00Z' } },
          clinic_id: 'clinic-A',
        },
      },
    })
    await asTool(buildCollectInfoTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({ field: 'name' })

    const update = mock.updateCalls.find((c) => c.table === 'conversations')
    const md = (update!.payload as {
      metadata: { existing_key: string; collected_info: Record<string, string> }
    }).metadata
    expect(md.existing_key).toBe('preserve_me')
    expect(md.collected_info.reason).toBe('2026-01-01T00:00:00Z')
    expect(md.collected_info.name).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
