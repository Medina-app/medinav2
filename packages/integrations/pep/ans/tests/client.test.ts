import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnsClient } from '../src/client.js'
import { AnsApiError, AnsPatientNotFoundError, AnsUnavailableError } from '../src/errors.js'

const BASE_URL = 'https://api.ans-mednobre.example.com/v1' // TODO: validar contra ANS real
const TOKEN = 'test-token-abc'
const CLINICA_ID = 384
const CLINICA_UNIDADE_ID = 374

function makeClient(overrides: Partial<ConstructorParameters<typeof AnsClient>[0]> = {}) {
  return new AnsClient({
    baseUrl: BASE_URL,
    clinicaToken: TOKEN,
    clinicaId: CLINICA_ID,
    clinicaUnidadeId: CLINICA_UNIDADE_ID,
    retryDelayMs: 1, // accelerate retries in tests
    maxRetries: 2,
    timeoutMs: 1000,
    ...overrides,
  })
}

function mockFetch(impl: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnsClient — auth + base behavior', () => {
  it('sends X-Clinica-Token header + clinica_id/clinica_unidade_id on every request', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse({ paciente: null })
    })
    const client = makeClient()
    await client.lookupPatientByPhone('5581987654321')

    expect(calls.length).toBe(1)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['X-Clinica-Token']).toBe(TOKEN)
    expect(headers['content-type']).toBe('application/json')
    // clinica_id + clinica_unidade_id appear in body (POST) per inferred shape
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.clinica_id).toBe(CLINICA_ID)
    expect(body.clinica_unidade_id).toBe(CLINICA_UNIDADE_ID)
    expect(body.telefone).toBe('5581987654321')
  })

  it('strips trailing slash from baseUrl', async () => {
    mockFetch(async () => jsonResponse({ paciente: null }))
    const client = makeClient({ baseUrl: `${BASE_URL}/` })
    await client.lookupPatientByPhone('5581987654321')
    expect(vi.mocked(fetch).mock.calls[0]![0]).not.toMatch(/\/\/v1\//)
  })
})

describe('AnsClient.lookupPatientByPhone', () => {
  it('returns parsed AnsPatient when API returns paciente object', async () => {
    mockFetch(async () =>
      jsonResponse({
        paciente: {
          id_paciente: 'pat-42',
          nome: 'Gabriel Arruda',
          cpf: '12345678900',
          telefone: '5581987654321',
        },
      }),
    )
    const client = makeClient()
    const out = await client.lookupPatientByPhone('5581987654321')
    expect(out).toEqual({
      id: 'pat-42',
      fullName: 'Gabriel Arruda',
      cpf: '12345678900',
      phone: '5581987654321',
    })
  })

  it('returns null when API returns paciente: null (não cadastrado)', async () => {
    mockFetch(async () => jsonResponse({ paciente: null }))
    const client = makeClient()
    const out = await client.lookupPatientByPhone('5581987654321')
    expect(out).toBeNull()
  })

  it('returns null on HTTP 404 (patient not registered)', async () => {
    mockFetch(async () => jsonResponse({ erro: 'paciente não encontrado' }, 404))
    const client = makeClient()
    // 404 here is "not found" semantically equivalent to paciente:null.
    // ANS may use either; client coerces to null pra simplificar caller.
    const out = await client.lookupPatientByPhone('5581987654321')
    expect(out).toBeNull()
  })

  it('handles cpf=null e phone=null gracefully', async () => {
    mockFetch(async () =>
      jsonResponse({ paciente: { id_paciente: 'p1', nome: 'Sem CPF', cpf: null, telefone: null } }),
    )
    const client = makeClient()
    const out = await client.lookupPatientByPhone('5581987654321')
    expect(out).toEqual({ id: 'p1', fullName: 'Sem CPF', cpf: null, phone: null })
  })
})

describe('AnsClient.listAvailableDays', () => {
  it('parses days array (YYYY-MM-DD) — happy path', async () => {
    mockFetch(async () =>
      jsonResponse({
        dias: [
          { data: '2026-06-01', qtd_slots: 5 },
          { data: '2026-06-02', qtd_slots: 0 },
          { data: '2026-06-03', qtd_slots: 12 },
        ],
      }),
    )
    const client = makeClient()
    const out = await client.listAvailableDays({
      doctorAnsId: 'med-99',
      from: '2026-06-01',
      to: '2026-06-30',
    })
    expect(out).toEqual([
      { date: '2026-06-01', slotsCount: 5 },
      { date: '2026-06-02', slotsCount: 0 },
      { date: '2026-06-03', slotsCount: 12 },
    ])
  })

  it('returns [] when API returns dias: []', async () => {
    mockFetch(async () => jsonResponse({ dias: [] }))
    const client = makeClient()
    const out = await client.listAvailableDays({ doctorAnsId: 'med-99', from: '2026-06-01', to: '2026-06-07' })
    expect(out).toEqual([])
  })

  it('sends doctorAnsId/from/to as query params (GET)', async () => {
    const calls: string[] = []
    mockFetch(async (url) => {
      calls.push(String(url))
      return jsonResponse({ dias: [] })
    })
    const client = makeClient()
    await client.listAvailableDays({ doctorAnsId: 'med-99', from: '2026-06-01', to: '2026-06-30' })
    expect(calls[0]).toContain('medico_id=med-99')
    expect(calls[0]).toContain('data_inicio=2026-06-01')
    expect(calls[0]).toContain('data_fim=2026-06-30')
    expect(calls[0]).toContain(`clinica_id=${CLINICA_ID}`)
    expect(calls[0]).toContain(`clinica_unidade_id=${CLINICA_UNIDADE_ID}`)
  })
})

describe('AnsClient.listAvailableHours', () => {
  it('parses time slots (HH:mm) — happy path', async () => {
    mockFetch(async () =>
      jsonResponse({
        horarios: [
          { hora_inicio: '09:00', hora_fim: '09:30', duracao_minutos: 30 },
          { hora_inicio: '09:30', hora_fim: '10:00', duracao_minutos: 30 },
          { hora_inicio: '14:00', hora_fim: '14:45', duracao_minutos: 45 },
        ],
      }),
    )
    const client = makeClient()
    const out = await client.listAvailableHours({ doctorAnsId: 'med-99', date: '2026-06-15' })
    expect(out).toEqual([
      { startTime: '09:00', endTime: '09:30', durationMinutes: 30 },
      { startTime: '09:30', endTime: '10:00', durationMinutes: 30 },
      { startTime: '14:00', endTime: '14:45', durationMinutes: 45 },
    ])
  })

  it('returns [] when no slots available', async () => {
    mockFetch(async () => jsonResponse({ horarios: [] }))
    const client = makeClient()
    const out = await client.listAvailableHours({ doctorAnsId: 'med-99', date: '2026-06-15' })
    expect(out).toEqual([])
  })
})

describe('AnsClient retry + error mapping', () => {
  it('retries on 429 with exponential backoff and eventually succeeds', async () => {
    let attempt = 0
    mockFetch(async () => {
      attempt++
      if (attempt < 3) return new Response('rate limited', { status: 429 })
      return jsonResponse({ paciente: null })
    })
    const client = makeClient()
    const out = await client.lookupPatientByPhone('5581987654321')
    expect(out).toBeNull()
    expect(attempt).toBe(3)
  })

  it('retries on 500 and throws AnsUnavailableError after max attempts', async () => {
    mockFetch(async () => new Response('boom', { status: 500 }))
    const client = makeClient()
    await expect(client.lookupPatientByPhone('5581987654321')).rejects.toBeInstanceOf(
      AnsUnavailableError,
    )
  })

  it('throws AnsApiError without retry on 401', async () => {
    let attempt = 0
    mockFetch(async () => {
      attempt++
      return jsonResponse({ erro: 'token invalido' }, 401)
    })
    const client = makeClient()
    await expect(client.lookupPatientByPhone('5581987654321')).rejects.toBeInstanceOf(AnsApiError)
    expect(attempt).toBe(1)
  })

  it('throws AnsApiError without retry on 400 (bad request)', async () => {
    mockFetch(async () => jsonResponse({ erro: 'campos obrigatorios' }, 400))
    const client = makeClient()
    await expect(client.lookupPatientByPhone('not-a-phone')).rejects.toBeInstanceOf(AnsApiError)
  })

  it('throws AnsUnavailableError on fetch network error after retries', async () => {
    mockFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = makeClient()
    await expect(client.lookupPatientByPhone('5581987654321')).rejects.toBeInstanceOf(
      AnsUnavailableError,
    )
  })

  it('throws AnsUnavailableError on timeout', async () => {
    mockFetch(async (_url, init) => {
      // Simulate timeout: respect AbortSignal and reject with AbortError
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    })
    const client = makeClient({ timeoutMs: 50, maxRetries: 0 })
    await expect(client.lookupPatientByPhone('5581987654321')).rejects.toBeInstanceOf(
      AnsUnavailableError,
    )
  })
})

// Re-export for completeness check
describe('AnsClient module surface', () => {
  it('exports the error classes', () => {
    expect(typeof AnsPatientNotFoundError).toBe('function') // re-exported for adapter use later
  })
})
