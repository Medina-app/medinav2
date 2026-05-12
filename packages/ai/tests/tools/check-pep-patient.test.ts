import { describe, it, expect, vi } from 'vitest'
import { buildCheckPepPatientTool } from '../../src/tools/check-pep-patient.js'
import { buildToolContext } from './_helpers.js'

interface ToolWithExecute {
  execute: (input: { phone: string }) => Promise<{
    ok: boolean
    exists?: boolean
    error?: string
    patientId?: string
    fullName?: string
    message?: string
  }>
}
const asTool = (t: unknown) => t as ToolWithExecute

function buildAnsMock(lookupResult: { id: string; fullName: string; cpf: string | null; phone: string | null } | null) {
  return {
    lookupPatientByPhone: vi.fn().mockResolvedValue(lookupResult),
    listAvailableDays: vi.fn(),
    listAvailableHours: vi.fn(),
  }
}

describe('check_pep_patient (M1a-2)', () => {
  it('returns ok:false error pep_ans_not_configured when ansClient undefined', async () => {
    const result = await asTool(buildCheckPepPatientTool(buildToolContext())).execute({
      phone: '5581987654321',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('pep_ans_not_configured')
  })

  it('returns exists:true with patientId+fullName when ANS finds patient', async () => {
    const ansClient = buildAnsMock({
      id: 'pat-99',
      fullName: 'Gabriel Arruda',
      cpf: '12345678900',
      phone: '5581987654321',
    })
    const result = await asTool(
      buildCheckPepPatientTool(buildToolContext({ ansClient: ansClient as never })),
    ).execute({ phone: '5581987654321' })

    expect(result.ok).toBe(true)
    expect(result.exists).toBe(true)
    expect(result.patientId).toBe('pat-99')
    expect(result.fullName).toBe('Gabriel Arruda')
    expect(ansClient.lookupPatientByPhone).toHaveBeenCalledWith('5581987654321')
  })

  it('returns exists:false when ANS returns null (não cadastrado)', async () => {
    const ansClient = buildAnsMock(null)
    const result = await asTool(
      buildCheckPepPatientTool(buildToolContext({ ansClient: ansClient as never })),
    ).execute({ phone: '5581987654321' })

    expect(result.ok).toBe(true)
    expect(result.exists).toBe(false)
    expect(result.message).toMatch(/cadastrad/i)
  })

  it('rejects invalid phone via Zod (does not call ansClient)', () => {
    const ansClient = buildAnsMock(null)
    const tool = buildCheckPepPatientTool(buildToolContext({ ansClient: ansClient as never }))
    const parsed = (tool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema.safeParse({
      phone: 'not-a-phone',
    })
    expect(parsed.success).toBe(false)
    expect(ansClient.lookupPatientByPhone).not.toHaveBeenCalled()
  })

  it('propagates ansClient errors (network/timeout etc)', async () => {
    const ansClient = {
      lookupPatientByPhone: vi.fn().mockRejectedValue(new Error('ANS unavailable: timeout')),
      listAvailableDays: vi.fn(),
      listAvailableHours: vi.fn(),
    }
    await expect(
      asTool(
        buildCheckPepPatientTool(buildToolContext({ ansClient: ansClient as never })),
      ).execute({ phone: '5581987654321' }),
    ).rejects.toThrow(/ANS unavailable/)
  })
})
