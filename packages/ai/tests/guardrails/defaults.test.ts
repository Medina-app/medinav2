import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BLOCKED_PATTERNS,
  DEFAULT_URGENT_PATTERNS,
  mergeGuardrails,
} from '../../src/guardrails/defaults.js'
import type { GuardrailsConfig } from '../../src/guardrails/types.js'

describe('AI-5: defaults + mergeGuardrails', () => {
  it('1. DEFAULT_BLOCKED_PATTERNS expõe 3 categorias canônicas (diagnosis/medication/diagnostic_advice)', () => {
    expect(DEFAULT_BLOCKED_PATTERNS).toHaveProperty('diagnosis_request')
    expect(DEFAULT_BLOCKED_PATTERNS).toHaveProperty('medication_request')
    expect(DEFAULT_BLOCKED_PATTERNS).toHaveProperty('diagnostic_advice')
    // symptom_interpretation deliberately NOT in defaults (high FP rate em PT-BR
    // coloquial). Available pra clínicas via additional_blocked_patterns.
    expect(DEFAULT_BLOCKED_PATTERNS).not.toHaveProperty('symptom_interpretation')

    expect(DEFAULT_URGENT_PATTERNS).toHaveProperty('suicide')
    expect(DEFAULT_URGENT_PATTERNS).toHaveProperty('bleeding')
    expect(DEFAULT_URGENT_PATTERNS).toHaveProperty('cardiac')
    expect(DEFAULT_URGENT_PATTERNS).toHaveProperty('trauma')

    // Sanity: cada categoria tem pelo menos 1 pattern.
    for (const [cat, list] of Object.entries(DEFAULT_BLOCKED_PATTERNS)) {
      expect(list.length, `blocked.${cat}`).toBeGreaterThan(0)
    }
    for (const [cat, list] of Object.entries(DEFAULT_URGENT_PATTERNS)) {
      expect(list.length, `urgent.${cat}`).toBeGreaterThan(0)
    }
  })

  it('2. mergeGuardrails(config={}) preserva defaults intactos (sem deep-mutation)', () => {
    const merged = mergeGuardrails({})
    // Mesmas categorias, mesmas RegExp source/flags.
    for (const cat of Object.keys(DEFAULT_BLOCKED_PATTERNS)) {
      expect(merged.blocked).toHaveProperty(cat)
      expect(merged.blocked[cat]?.length).toBe(DEFAULT_BLOCKED_PATTERNS[cat]?.length)
    }
    for (const cat of Object.keys(DEFAULT_URGENT_PATTERNS)) {
      expect(merged.urgent).toHaveProperty(cat)
      expect(merged.urgent[cat]?.length).toBe(DEFAULT_URGENT_PATTERNS[cat]?.length)
    }
    // Defesa contra mutação acidental: original não pode ser mutado por merge.
    const beforeLen = DEFAULT_BLOCKED_PATTERNS['diagnosis_request']?.length ?? 0
    mergeGuardrails({
      additional_blocked_patterns: { diagnosis_request: ['\\bfoo\\b'] },
    })
    expect(DEFAULT_BLOCKED_PATTERNS['diagnosis_request']?.length).toBe(beforeLen)
  })

  it('3. additional_blocked_patterns concatena (não substitui) na categoria existente', () => {
    const config: GuardrailsConfig = {
      additional_blocked_patterns: {
        medication_request: ['\\bibuprofeno especifico\\b'],
      },
    }
    const merged = mergeGuardrails(config)
    const baseLen = DEFAULT_BLOCKED_PATTERNS['medication_request']?.length ?? 0
    expect(merged.blocked['medication_request']?.length).toBe(baseLen + 1)
    // Pattern novo está no fim (defaults primeiro, override depois).
    const last = merged.blocked['medication_request']?.[baseLen]
    expect(last?.source).toContain('ibuprofeno')
    expect(last?.flags).toContain('i') // case-insensitive
  })

  it('4. additional_blocked_patterns cria categoria nova quando não existe', () => {
    const config: GuardrailsConfig = {
      additional_blocked_patterns: {
        custom_clinic_topic: ['\\bbotox\\b', '\\bpreenchimento\\b'],
      },
    }
    const merged = mergeGuardrails(config)
    expect(merged.blocked['custom_clinic_topic']?.length).toBe(2)
    expect(merged.blocked['custom_clinic_topic']?.[0]?.test('quero botox')).toBe(true)
  })

  it('5. disabled_default_categories remove categoria de blocked E urgent', () => {
    const config: GuardrailsConfig = {
      disabled_default_categories: ['diagnostic_advice', 'trauma'],
    }
    const merged = mergeGuardrails(config)
    expect(merged.blocked).not.toHaveProperty('diagnostic_advice')
    expect(merged.urgent).not.toHaveProperty('trauma')
    // Outras categorias intactas.
    expect(merged.blocked).toHaveProperty('medication_request')
    expect(merged.urgent).toHaveProperty('suicide')
  })

  it('6. additional_blocked_patterns com regex inválida lança erro descritivo', () => {
    const config: GuardrailsConfig = {
      additional_blocked_patterns: {
        broken_cat: ['(unbalanced'],
      },
    }
    expect(() => mergeGuardrails(config)).toThrow(/broken_cat/)
    expect(() => mergeGuardrails(config)).toThrow(/regex/i)
  })

  it('6a. ReDoS defense — pattern > 200 chars rejeitado', () => {
    const longPattern = 'a'.repeat(201)
    const config: GuardrailsConfig = {
      additional_blocked_patterns: { abuse_long: [longPattern] },
    }
    expect(() => mergeGuardrails(config)).toThrow(/abuse_long/)
    expect(() => mergeGuardrails(config)).toThrow(/200|ReDoS/i)
  })

  it('6b. ReDoS defense — quantifier aninhado rejeitado', () => {
    // Padrões clássicos de catastrophic backtracking.
    const dangerous = ['(a+)+', '(a*)*', '(.+)+', '(\\d*)+', '(ab+)*']
    for (const p of dangerous) {
      const config: GuardrailsConfig = {
        additional_blocked_patterns: { abuse_nested: [p] },
      }
      expect(() => mergeGuardrails(config), `pattern=${p}`).toThrow(/aninhado|ReDoS/i)
    }
  })

  it('6c. ReDoS defense — patterns válidos legítimos PT-BR continuam compilando', () => {
    const config: GuardrailsConfig = {
      additional_blocked_patterns: {
        clinic_topic: [
          '\\b(botox|preenchimento)\\b',
          '\\bdescon[a-zçãõéêíóúâ]+gestion[a-zçãõéêíóúâ]+\\b',
          '(?:^|\\s)(é|e) (uma )?(rinite|sinusite)\\b',
        ],
      },
    }
    expect(() => mergeGuardrails(config)).not.toThrow()
  })

  it('7. defaults compilam com flag i (case-insensitive)', () => {
    // Seleção representativa em vez de iterar tudo.
    expect(DEFAULT_BLOCKED_PATTERNS['medication_request']?.[0]?.flags).toContain('i')
    expect(DEFAULT_URGENT_PATTERNS['suicide']?.[0]?.flags).toContain('i')
  })

  it('8. additional_urgent_patterns: mesmo merge model que blocked', () => {
    const config: GuardrailsConfig = {
      additional_urgent_patterns: {
        clinic_specific_emergency: ['\\bcrise hipertensiva\\b'],
      },
    }
    const merged = mergeGuardrails(config)
    expect(merged.urgent['clinic_specific_emergency']?.length).toBe(1)
    expect(merged.urgent['clinic_specific_emergency']?.[0]?.test('paciente em crise hipertensiva')).toBe(true)
  })
})
