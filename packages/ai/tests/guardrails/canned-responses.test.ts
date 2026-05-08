import { describe, expect, it } from 'vitest'
import { getCannedResponse } from '../../src/guardrails/canned-responses.js'
import { validateOutput } from '../../src/guardrails/post-filter.js'
import type { EscalatedReason } from '../../src/guardrails/types.js'

const ALL_REASONS: EscalatedReason[] = [
  'medication',
  'diagnosis',
  'urgency',
  'symptom',
  'other',
]

describe('AI-5: getCannedResponse', () => {
  it('1. todas as 5 EscalatedReason têm canned response não-vazia', () => {
    for (const r of ALL_REASONS) {
      const text = getCannedResponse(r)
      expect(text.length, `reason=${r}`).toBeGreaterThan(20)
    }
  })

  it('2. urgency: inclui CVV 188 (suicide) e SAMU 192 (geral)', () => {
    const text = getCannedResponse('urgency')
    expect(text).toContain('188')
    expect(text).toContain('192')
    expect(text).toMatch(/CVV/i)
    expect(text).toMatch(/SAMU/i)
  })

  it('3. defense-in-depth: nenhum canned response viola post-filter', () => {
    // Eat your own dogfood — se a canned acidentalmente recomendar remédio
    // ou diagnosticar, validateOutput pega.
    for (const r of ALL_REASONS) {
      const text = getCannedResponse(r)
      const v = validateOutput(text, {})
      expect(v.valid, `reason=${r} text="${text}" violation=${JSON.stringify(v.violation)}`).toBe(
        true,
      )
    }
  })

  it('4. medication: não menciona princípio ativo específico (dipirona/paracetamol/etc)', () => {
    const text = getCannedResponse('medication').toLowerCase()
    expect(text).not.toMatch(/\b(dipirona|paracetamol|ibuprofeno|amoxicilina|nimesulida|omeprazol|losartana)\b/)
  })

  it('5. diagnosis: não menciona doença específica (alergia/dengue/câncer/etc)', () => {
    const text = getCannedResponse('diagnosis').toLowerCase()
    expect(text).not.toMatch(/\b(alergia|gripe|dengue|covid|c[aâ]ncer|tumor|sinusite|enxaqueca|diabete[s]?)\b/)
  })

  it('6. medication + diagnosis: deixam claro que vão escalar pra humano', () => {
    expect(getCannedResponse('medication').toLowerCase()).toMatch(/atendente|humano|consulta/)
    expect(getCannedResponse('diagnosis').toLowerCase()).toMatch(/atendente|humano|consulta|m[eé]dico/)
  })

  it('7. symptom + other: também escalam pra humano (consistência)', () => {
    expect(getCannedResponse('symptom').toLowerCase()).toMatch(/atendente|humano|time/)
    expect(getCannedResponse('other').toLowerCase()).toMatch(/atendente|humano/)
  })
})
