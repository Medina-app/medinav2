import { describe, expect, it } from 'vitest'
import { validateOutput } from '../../src/guardrails/post-filter.js'
import type { GuardrailsConfig } from '../../src/guardrails/types.js'

describe('AI-5: validateOutput (post-filter)', () => {
  it('1. bloqueia output do LLM com diagnóstico declarativo ("você tem X")', () => {
    const out = 'Pelo que você descreve, parece que você tem alergia. Recomendo procurar um médico.'
    const r = validateOutput(out, {})
    expect(r.valid).toBe(false)
    expect(r.violation?.category).toBe('diagnosis_request')
    expect(r.violation?.evidence).toBeTruthy()
  })

  it('2. bloqueia output do LLM recomendando medicamento ("você pode tomar X")', () => {
    const out = 'Você pode tomar paracetamol 500mg de 6 em 6 horas pra aliviar a dor.'
    const r = validateOutput(out, {})
    expect(r.valid).toBe(false)
    expect(r.violation?.category).toBe('medication_request')
  })

  it('3. bloqueia output com avaliação clínica ("isso é grave")', () => {
    const out = 'Sim, isso é grave. Você precisa ir ao hospital agora.'
    const r = validateOutput(out, {})
    expect(r.valid).toBe(false)
    // Match pode ser tanto diagnosis_request (isso é grave) quanto
    // diagnostic_advice (preciso ir ao hospital). Aceita qualquer uma.
    expect(['diagnosis_request', 'diagnostic_advice']).toContain(r.violation?.category)
  })

  it('4. bloqueia output prescritivo com dosagem ("tome 1 comprimido")', () => {
    const out = 'Tome 1 comprimido de dipirona agora e procure ajuda.'
    const r = validateOutput(out, {})
    expect(r.valid).toBe(false)
    expect(r.violation?.category).toBe('medication_request')
  })

  it('5. permite resposta administrativa segura (horário/preço/agendamento)', () => {
    expect(
      validateOutput('Nosso horário de atendimento é de segunda a sexta, das 8h às 18h.', {}).valid,
    ).toBe(true)
    expect(validateOutput('A consulta com clínico geral custa R$ 250.', {}).valid).toBe(true)
    expect(
      validateOutput('Posso te ajudar a marcar uma consulta com a Dra. Ana?', {}).valid,
    ).toBe(true)
    expect(validateOutput('Bom dia! Em que posso te ajudar hoje?', {}).valid).toBe(true)
  })

  it('6. respeita disabled_default_categories — diagnostic_advice off deixa "vai melhorar" passar', () => {
    const config: GuardrailsConfig = { disabled_default_categories: ['diagnostic_advice'] }
    const r = validateOutput('Não se preocupe, vai melhorar com o tempo.', config)
    expect(r.valid).toBe(true)
  })

  it('7. additional_blocked_patterns: clinic adiciona pattern e detecta no output', () => {
    const config: GuardrailsConfig = {
      additional_blocked_patterns: { topic_estetica: ['\\bbotox|preenchimento\\b'] },
    }
    const r = validateOutput('Recomendo um botox pra esses sinais.', config)
    expect(r.valid).toBe(false)
    expect(r.violation?.category).toBe('topic_estetica')
  })

  it('8. cross-tenant: pattern da clinic A não vaza pra clinic B', () => {
    const configA: GuardrailsConfig = {
      additional_blocked_patterns: { secret_a: ['\\btoken-clinicA\\b'] },
    }
    const configB: GuardrailsConfig = {
      additional_blocked_patterns: { secret_b: ['\\btoken-clinicB\\b'] },
    }
    expect(validateOutput('o token-clinicA fica aqui', configA).valid).toBe(false)
    expect(validateOutput('o token-clinicA fica aqui', configB).valid).toBe(true)
  })

  it('9. output válido retorna { valid: true } sem campo violation', () => {
    const r = validateOutput('Tudo certo! Te aguardo na quinta às 14h.', {})
    expect(r.valid).toBe(true)
    expect(r.violation).toBeUndefined()
  })

  it('10. evidence sanitizada quando output viola — sem dígitos crus, max 80 chars', () => {
    // Output prescritivo com dígitos (dosagem) — sanitize deve mascarar.
    const r = validateOutput('Você pode tomar paracetamol 500mg de 6 em 6 horas pra a dor.', {})
    expect(r.valid).toBe(false)
    expect(r.violation?.evidence).toBeDefined()
    expect(r.violation?.evidence).not.toMatch(/\d/)
    expect((r.violation?.evidence ?? '').length).toBeLessThanOrEqual(80)
  })
})
