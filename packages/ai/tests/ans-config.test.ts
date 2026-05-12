import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveAnsConfig } from '../src/ans-config.js'

const ORIGINAL_ENV = {
  ANS_BASE_URL: process.env['ANS_BASE_URL'],
  ANS_CLINICA_TOKEN: process.env['ANS_CLINICA_TOKEN'],
  ANS_CLINICA_ID: process.env['ANS_CLINICA_ID'],
  ANS_CLINICA_UNIDADE_ID: process.env['ANS_CLINICA_UNIDADE_ID'],
}

beforeEach(() => {
  delete process.env['ANS_BASE_URL']
  delete process.env['ANS_CLINICA_TOKEN']
  delete process.env['ANS_CLINICA_ID']
  delete process.env['ANS_CLINICA_UNIDADE_ID']
})

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
})

describe('resolveAnsConfig (M1a-2)', () => {
  it('returns config when all env vars set', async () => {
    process.env['ANS_BASE_URL'] = 'https://api.ans.example.com/v1'
    process.env['ANS_CLINICA_TOKEN'] = 'abc123'
    process.env['ANS_CLINICA_ID'] = '384'
    process.env['ANS_CLINICA_UNIDADE_ID'] = '374'

    const cfg = await resolveAnsConfig()
    expect(cfg).toEqual({
      baseUrl: 'https://api.ans.example.com/v1',
      clinicaToken: 'abc123',
      clinicaId: 384,
      clinicaUnidadeId: 374,
    })
  })

  it('trims whitespace from baseUrl + token', async () => {
    process.env['ANS_BASE_URL'] = '  https://api.ans.example.com/v1  '
    process.env['ANS_CLINICA_TOKEN'] = '  tok  '
    process.env['ANS_CLINICA_ID'] = '384'
    process.env['ANS_CLINICA_UNIDADE_ID'] = '374'

    const cfg = await resolveAnsConfig()
    expect(cfg?.baseUrl).toBe('https://api.ans.example.com/v1')
    expect(cfg?.clinicaToken).toBe('tok')
  })

  it('returns null when ANS_BASE_URL missing', async () => {
    process.env['ANS_CLINICA_TOKEN'] = 'tok'
    process.env['ANS_CLINICA_ID'] = '384'
    process.env['ANS_CLINICA_UNIDADE_ID'] = '374'
    expect(await resolveAnsConfig()).toBeNull()
  })

  it('returns null when ANS_CLINICA_TOKEN missing', async () => {
    process.env['ANS_BASE_URL'] = 'https://api.ans.example.com/v1'
    process.env['ANS_CLINICA_ID'] = '384'
    process.env['ANS_CLINICA_UNIDADE_ID'] = '374'
    expect(await resolveAnsConfig()).toBeNull()
  })

  it('returns null when clinica_id is not a number', async () => {
    process.env['ANS_BASE_URL'] = 'https://api.ans.example.com/v1'
    process.env['ANS_CLINICA_TOKEN'] = 'tok'
    process.env['ANS_CLINICA_ID'] = 'not-a-number'
    process.env['ANS_CLINICA_UNIDADE_ID'] = '374'
    expect(await resolveAnsConfig()).toBeNull()
  })

  it('returns null when clinica_unidade_id is not a number', async () => {
    process.env['ANS_BASE_URL'] = 'https://api.ans.example.com/v1'
    process.env['ANS_CLINICA_TOKEN'] = 'tok'
    process.env['ANS_CLINICA_ID'] = '384'
    process.env['ANS_CLINICA_UNIDADE_ID'] = ''
    expect(await resolveAnsConfig()).toBeNull()
  })
})
