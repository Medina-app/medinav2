import { describe, expect, it, vi } from 'vitest'
import { detectUrgency } from '../../src/guardrails/urgency-detector.js'
import type { GuardrailsConfig } from '../../src/guardrails/types.js'

describe('AI-5: detectUrgency', () => {
  it('1. regex: detecta ideação suicida → critical/suicide', async () => {
    const r = await detectUrgency('vou me matar', { config: {} })
    expect(r.level).toBe('critical')
    expect(r.category).toBe('suicide')
    expect(r.source).toBe('regex')
    expect(r.evidence).toMatch(/vou me matar/i)
  })

  it('2. regex: detecta sangramento → critical/bleeding', async () => {
    const r = await detectUrgency('estou sangrando muito da boca', { config: {} })
    expect(r.level).toBe('critical')
    expect(r.category).toBe('bleeding')
    expect(r.source).toBe('regex')
  })

  it('3. regex: detecta sintoma cardíaco → critical/cardiac', async () => {
    const r = await detectUrgency('dor forte no peito e não consigo respirar', { config: {} })
    expect(r.level).toBe('critical')
    expect(r.category).toBe('cardiac')
    expect(r.source).toBe('regex')
  })

  it('4. regex inconclusivo + llmFallback off: retorna low (não chama LLM)', async () => {
    const llmClassify = vi.fn()
    const r = await detectUrgency('boa tarde, gostaria de marcar consulta', {
      config: {},
      llmFallbackEnabled: false,
      llmClassify,
    })
    expect(r.level).toBe('low')
    expect(r.source).toBe('regex')
    expect(llmClassify).not.toHaveBeenCalled()
  })

  it('5. regex inconclusivo + LLM critical: retorna critical (source=llm)', async () => {
    const llmClassify = vi.fn().mockResolvedValue({ level: 'critical', category: 'suicide' })
    const r = await detectUrgency('não vejo mais sentido, vou acabar com tudo', {
      config: {},
      llmFallbackEnabled: true,
      llmClassify,
    })
    expect(r.level).toBe('critical')
    expect(r.category).toBe('suicide')
    expect(r.source).toBe('llm')
    expect(llmClassify).toHaveBeenCalledOnce()
  })

  it('6. regex inconclusivo + LLM low: retorna low (source=llm) — passa pro fluxo normal', async () => {
    const llmClassify = vi.fn().mockResolvedValue({ level: 'low' })
    const r = await detectUrgency('queria saber se vocês atendem por convênio', {
      config: {},
      llmFallbackEnabled: true,
      llmClassify,
    })
    expect(r.level).toBe('low')
    expect(r.source).toBe('llm')
  })

  it('7. LLM timeout 3s: fallback medium (não bloqueia dispatch)', async () => {
    const llmClassify = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ level: 'low' }), 10_000)),
    )
    const r = await detectUrgency('mensagem ambígua', {
      config: {},
      llmFallbackEnabled: true,
      llmClassify,
      timeoutMs: 50, // tight pra test rápido
    })
    expect(r.level).toBe('medium')
    expect(r.source).toBe('fallback')
  })

  it('8. LLM lança erro: fallback medium (mesma defesa do timeout)', async () => {
    const llmClassify = vi.fn().mockRejectedValue(new Error('openrouter 503'))
    const r = await detectUrgency('mensagem ambígua', {
      config: {},
      llmFallbackEnabled: true,
      llmClassify,
    })
    expect(r.level).toBe('medium')
    expect(r.source).toBe('fallback')
  })

  it('9. additional_urgent_patterns: clínica adiciona pattern e dispara critical', async () => {
    const config: GuardrailsConfig = {
      additional_urgent_patterns: {
        clinic_specific: ['\\bcrise hipertensiva\\b'],
      },
    }
    const r = await detectUrgency('paciente em crise hipertensiva', { config })
    expect(r.level).toBe('critical')
    expect(r.category).toBe('clinic_specific')
    expect(r.source).toBe('regex')
  })

  it('10. disabled_default_categories: trauma desligado → mensagem de trauma volta low', async () => {
    const config: GuardrailsConfig = { disabled_default_categories: ['trauma'] }
    const r = await detectUrgency('quebrei a perna agora', {
      config,
      llmFallbackEnabled: false,
    })
    // Sem pattern matchando + LLM off → low.
    expect(r.level).toBe('low')
  })
})
