import { describe, expect, it } from 'vitest'
import { preFilterMessage } from '../../src/guardrails/pre-filter.js'
import type { GuardrailsConfig } from '../../src/guardrails/types.js'

describe('AI-5: preFilterMessage', () => {
  it('1. bloqueia pedido de medicação e mapeia reason=medication', () => {
    const m = preFilterMessage('tô com dor de cabeça, qual remédio posso tomar?', {})
    expect(m.matched).toBe(true)
    if (m.matched) {
      expect(m.category).toBe('medication_request')
      expect(m.reason).toBe('medication')
      expect(m.evidence).toMatch(/qual rem[eé]dio posso tomar/i)
    }
  })

  it('2. bloqueia pedido de diagnóstico e mapeia reason=diagnosis', () => {
    const m = preFilterMessage('doutor, o que eu tenho?', {})
    expect(m.matched).toBe(true)
    if (m.matched) {
      expect(m.category).toBe('diagnosis_request')
      expect(m.reason).toBe('diagnosis')
    }
  })

  it('3. permite perguntas administrativas (horário, preço, endereço)', () => {
    expect(preFilterMessage('qual o horário de funcionamento?', {}).matched).toBe(false)
    expect(preFilterMessage('quanto custa a consulta?', {}).matched).toBe(false)
    expect(preFilterMessage('onde fica a clínica?', {}).matched).toBe(false)
    expect(preFilterMessage('vocês atendem convênio Unimed?', {}).matched).toBe(false)
  })

  it('4. permite saudações e small talk', () => {
    expect(preFilterMessage('oi, bom dia', {}).matched).toBe(false)
    expect(preFilterMessage('boa tarde, tudo bem?', {}).matched).toBe(false)
    expect(preFilterMessage('obrigado!', {}).matched).toBe(false)
  })

  it('5. respeita disabled_default_categories — medication desligada deixa passar', () => {
    const config: GuardrailsConfig = { disabled_default_categories: ['medication_request'] }
    const m = preFilterMessage('qual remédio devo tomar?', config)
    expect(m.matched).toBe(false)
  })

  it('6. aplica additional_blocked_patterns da clínica e mapeia reason=other', () => {
    const config: GuardrailsConfig = {
      additional_blocked_patterns: {
        topic_botox: ['\\b(botox|preenchimento)\\b'],
      },
    }
    const m = preFilterMessage('quero fazer botox', config)
    expect(m.matched).toBe(true)
    if (m.matched) {
      expect(m.category).toBe('topic_botox')
      // Categoria custom não tem mapping em CATEGORY_TO_REASON → 'other'.
      expect(m.reason).toBe('other')
    }
  })

  it('7. cross-tenant: pattern da clinic A não vaza pra clinic B', () => {
    const configA: GuardrailsConfig = {
      additional_blocked_patterns: { topic_a: ['\\bclinicA-secreto\\b'] },
    }
    const configB: GuardrailsConfig = {
      additional_blocked_patterns: { topic_b: ['\\bclinicB-secreto\\b'] },
    }
    // Mensagem que matcharia em A NÃO matcha em B (cada call usa seu config).
    expect(preFilterMessage('clinicA-secreto', configA).matched).toBe(true)
    expect(preFilterMessage('clinicA-secreto', configB).matched).toBe(false)
    expect(preFilterMessage('clinicB-secreto', configA).matched).toBe(false)
    expect(preFilterMessage('clinicB-secreto', configB).matched).toBe(true)
  })

  it('8. relato puro (sem verbo de intenção) não dispara medication_request', () => {
    // FP doc: "tomei dipirona ontem" é relato — pre-filter NÃO deve disparar.
    expect(preFilterMessage('tomei dipirona ontem', {}).matched).toBe(false)
    expect(preFilterMessage('já tomo paracetamol há anos', {}).matched).toBe(false)
  })

  it('9. diagnostic_advice mapeia pra reason=diagnosis (não symptom)', () => {
    const m = preFilterMessage('isso é normal?', {})
    expect(m.matched).toBe(true)
    if (m.matched) {
      expect(m.category).toBe('diagnostic_advice')
      expect(m.reason).toBe('diagnosis')
    }
  })
})
