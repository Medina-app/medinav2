import { describe, it, expect, vi } from 'vitest'
import { makeAnsAdapter } from '../src/adapter.js'
import { AnsClient } from '../src/client.js'

describe('makeAnsAdapter', () => {
  it('delegates lookupPatientByPhone to client', async () => {
    const client = {
      lookupPatientByPhone: vi.fn().mockResolvedValue({
        id: 'p1',
        fullName: 'Test',
        cpf: null,
        phone: '5581987654321',
      }),
      listAvailableDays: vi.fn(),
      listAvailableHours: vi.fn(),
    } as unknown as AnsClient

    const adapter = makeAnsAdapter(client)
    const result = await adapter.lookupPatientByPhone('5581987654321')

    expect(client.lookupPatientByPhone).toHaveBeenCalledWith('5581987654321')
    expect(result).toEqual({ id: 'p1', fullName: 'Test', cpf: null, phone: '5581987654321' })
  })

  it('delegates listAvailableDays to client', async () => {
    const client = {
      lookupPatientByPhone: vi.fn(),
      listAvailableDays: vi.fn().mockResolvedValue([
        { date: '2026-06-01', slotsCount: 3 },
        { date: '2026-06-02', slotsCount: 1 },
      ]),
      listAvailableHours: vi.fn(),
    } as unknown as AnsClient

    const adapter = makeAnsAdapter(client)
    const result = await adapter.listAvailableDays({
      doctorAnsId: 'med-1',
      from: '2026-06-01',
      to: '2026-06-30',
    })

    expect(client.listAvailableDays).toHaveBeenCalledWith({
      doctorAnsId: 'med-1',
      from: '2026-06-01',
      to: '2026-06-30',
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ date: '2026-06-01', slotsCount: 3 })
  })

  it('delegates listAvailableHours to client', async () => {
    const client = {
      lookupPatientByPhone: vi.fn(),
      listAvailableDays: vi.fn(),
      listAvailableHours: vi.fn().mockResolvedValue([
        { startTime: '09:00', endTime: '09:30', durationMinutes: 30 },
      ]),
    } as unknown as AnsClient

    const adapter = makeAnsAdapter(client)
    const result = await adapter.listAvailableHours({ doctorAnsId: 'med-1', date: '2026-06-15' })

    expect(client.listAvailableHours).toHaveBeenCalledWith({
      doctorAnsId: 'med-1',
      date: '2026-06-15',
    })
    expect(result).toEqual([{ startTime: '09:00', endTime: '09:30', durationMinutes: 30 }])
  })

  it('propagates errors from client methods', async () => {
    const client = {
      lookupPatientByPhone: vi.fn().mockRejectedValue(new Error('upstream timeout')),
      listAvailableDays: vi.fn(),
      listAvailableHours: vi.fn(),
    } as unknown as AnsClient

    const adapter = makeAnsAdapter(client)
    await expect(adapter.lookupPatientByPhone('5581987654321')).rejects.toThrow(/upstream timeout/)
  })
})
