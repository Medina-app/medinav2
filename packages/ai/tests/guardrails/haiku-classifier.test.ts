import { describe, expect, it, vi } from 'vitest'
import { createHaikuClassifier } from '../../src/guardrails/haiku-classifier.js'

/** Builder de fetch mock que devolve JSON OpenRouter-shape. */
function fakeFetch(content: string, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => content,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response) as unknown as typeof fetch
}

describe('AI-5: createHaikuClassifier', () => {
  it('lança quando OPENROUTER_API_KEY ausente e nenhuma key passada via opts', () => {
    const orig = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() => createHaikuClassifier()).toThrow(/OPENROUTER_API_KEY/)
    } finally {
      if (orig != null) process.env['OPENROUTER_API_KEY'] = orig
    }
  })

  it('parses JSON válido com level + category whitelist', async () => {
    const classify = createHaikuClassifier({
      apiKey: 'test',
      fetch: fakeFetch(JSON.stringify({ level: 'critical', category: 'suicide' })),
    })
    const r = await classify('vou acabar com tudo')
    expect(r.level).toBe('critical')
    expect(r.category).toBe('suicide')
  })

  it('omite category=none (não-classificável)', async () => {
    const classify = createHaikuClassifier({
      apiKey: 'test',
      fetch: fakeFetch(JSON.stringify({ level: 'low', category: 'none' })),
    })
    const r = await classify('boa tarde')
    expect(r.level).toBe('low')
    expect(r.category).toBeUndefined()
  })

  it('descarta category fora da whitelist (LLM desobedecendo SYSTEM_PROMPT)', async () => {
    // LLM inventou categoria fora do enum — devemos descartar silenciosamente
    // pra não propagar string não confiável pra logs/spans.
    const classify = createHaikuClassifier({
      apiKey: 'test',
      fetch: fakeFetch(JSON.stringify({ level: 'critical', category: 'totally-made-up' })),
    })
    const r = await classify('mensagem ambígua')
    expect(r.level).toBe('critical')
    expect(r.category).toBeUndefined()
  })

  it('lança em level inválido', async () => {
    const classify = createHaikuClassifier({
      apiKey: 'test',
      fetch: fakeFetch(JSON.stringify({ level: 'unknown' })),
    })
    await expect(classify('msg')).rejects.toThrow(/invalid level/i)
  })

  it('lança em HTTP não-2xx', async () => {
    const classify = createHaikuClassifier({
      apiKey: 'test',
      fetch: fakeFetch('rate limited', 429),
    })
    await expect(classify('msg')).rejects.toThrow(/429/)
  })

  it('lança em response não-JSON', async () => {
    const classify = createHaikuClassifier({
      apiKey: 'test',
      fetch: fakeFetch('not json at all'),
    })
    await expect(classify('msg')).rejects.toThrow(/non-JSON/i)
  })
})
