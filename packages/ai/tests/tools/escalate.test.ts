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

// PR-A: escalate.ts now delegates everything to the atomic
// public.escalate_conversation(uuid, uuid, text) RETURNS boolean RPC.
// The TS layer only:
//   1. Validates input via Zod (reason min 3 chars).
//   2. Calls supabase.rpc('escalate_conversation', { p_conversation_id, p_clinic_id, p_reason }).
//   3. Maps RPC result:
//        data === false   -> { ok: false, error: 'ja_transferida' }  (idempotent)
//        error !== null   -> throw                                   (cross-tenant, invalid state, etc)
//        otherwise        -> { ok: true }
// Cross-tenant guard, system message INSERT, audit_logs INSERT, and state
// transition validation all live inside the PL/pgSQL function. Covered by
// packages/db/tests/rls/cross-tenant-ai.test.ts integration tests, not here.
describe('escalate_to_human (PR-A: atomic RPC)', () => {
  it('calls escalate_conversation RPC with p_conversation_id, p_clinic_id, p_reason and returns ok=true', async () => {
    const mock = buildMockSupabase({}, { data: true, error: null })
    const tool = asTool(buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ reason: 'paciente com urgência médica' })

    expect(result.ok).toBe(true)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
    expect(mock.rpc).toHaveBeenCalledWith('escalate_conversation', {
      p_conversation_id: 'conv-1',
      p_clinic_id: 'clinic-A',
      p_reason: 'paciente com urgência médica',
    })
    // No direct INSERTs from the TS layer — the function does it all.
    expect(mock.insertCalls).toHaveLength(0)
  })

  it('returns ok=false with error="já_transferida" when RPC returns data=false (idempotent)', async () => {
    const mock = buildMockSupabase({}, { data: false, error: null })
    const tool = asTool(buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ reason: 'tentando escalar de novo' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('já_transferida')
    expect(mock.insertCalls).toHaveLength(0)
  })

  it('throws when RPC returns error (cross-tenant violation propagates from PL/pgSQL)', async () => {
    const mock = buildMockSupabase(
      {},
      { data: null, error: { message: 'cross-tenant violation: conversation X belongs to Y, not Z' } },
    )
    const tool = asTool(buildEscalateTool(buildToolContext({ supabase: mock.supabase as never })))

    await expect(tool.execute({ reason: 'malicious' })).rejects.toThrow(/cross-tenant violation/)
  })

  it('Zod validates reason min length (3 chars)', () => {
    const tool = asTool(buildEscalateTool(buildToolContext()))
    expect(tool.inputSchema.safeParse({ reason: 'x' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ reason: 'paciente irritado' }).success).toBe(true)
  })
})
