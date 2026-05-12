import { describe, expect, it, vi } from 'vitest'
import { createFactsExtractor, extractJsonObject } from '../../src/patient-memory/extractor.js'

function fakeFetch(payload: unknown, status = 200): typeof fetch {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => content,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response) as unknown as typeof fetch
}

const baseInput = {
  messages: [
    { role: 'user' as const, content: 'Oi, meu nome é João e prefiro ser chamado de Jô' },
    { role: 'assistant' as const, content: 'Combinado, Jô!' },
  ],
  categories: new Set(['administrative', 'financial']) as ReadonlySet<'administrative' | 'financial'>,
}

describe('AI-6: createFactsExtractor', () => {
  it('lança quando OPENROUTER_API_KEY ausente e nenhuma key passada via opts', () => {
    const orig = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() => createFactsExtractor()).toThrow(/OPENROUTER_API_KEY/)
    } finally {
      if (orig != null) process.env['OPENROUTER_API_KEY'] = orig
    }
  })

  it('retorna facts válidos quando LLM responde JSON correto', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.95 },
        ],
      }),
    })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ key: 'preferred_name', value: 'Jô', category: 'administrative' })
  })

  it('descarta fact cuja key está fora do whitelist administrativo', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'cpf', value: '12345678900', confidence: 0.9 },
          { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.9 },
        ],
      }),
    })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.key).toBe('preferred_name')
  })

  it('descarta fact cuja categoria não está habilitada pela clínica', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.9 },
          { category: 'financial', key: 'health_plan_name', value: 'Unimed', confidence: 0.9 },
        ],
      }),
    })
    const facts = await extract({
      ...baseInput,
      categories: new Set(['administrative']) as ReadonlySet<'administrative' | 'financial'>,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.category).toBe('administrative')
  })

  it('LGPD: descarta fact cujo value casa com blocklist médico (Haiku slipped)', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'profession', value: 'engenheiro com diagnóstico de hipertensão', confidence: 0.9 },
          { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.9 },
        ],
      }),
    })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.key).toBe('preferred_name')
  })

  it('LGPD: descarta múltiplas palavras-gatilho médicas (dor, remédio, alergia, grávida, sintoma)', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'profession', value: 'sente dor crônica', confidence: 0.9 },
          { category: 'administrative', key: 'profession', value: 'toma remédio diário', confidence: 0.9 },
          { category: 'administrative', key: 'profession', value: 'alergia a látex', confidence: 0.9 },
          { category: 'administrative', key: 'profession', value: 'está grávida', confidence: 0.9 },
          { category: 'administrative', key: 'profession', value: 'sintoma persistente', confidence: 0.9 },
        ],
      }),
    })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(0)
  })

  it('descarta fact que falha Zod (confidence > 1)', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 1.5 },
        ],
      }),
    })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(0)
  })

  it('descarta fact com value vazio', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [
          { category: 'administrative', key: 'preferred_name', value: '', confidence: 0.9 },
        ],
      }),
    })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(0)
  })

  it('retorna array vazio quando LLM responde facts: []', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({ facts: [] }),
    })
    const facts = await extract(baseInput)
    expect(facts).toEqual([])
  })

  it('lança em HTTP não-2xx', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch('rate limited', 429),
    })
    await expect(extract(baseInput)).rejects.toThrow(/429/)
  })

  it('lança em response não-JSON', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch('not json at all'),
    })
    await expect(extract(baseInput)).rejects.toThrow(/non-JSON/i)
  })

  it('retorna [] quando categorias é Set vazio (memory desligado)', async () => {
    const extract = createFactsExtractor({
      apiKey: 'test',
      fetch: fakeFetch({
        facts: [{ category: 'administrative', key: 'preferred_name', value: 'Jô', confidence: 0.9 }],
      }),
    })
    const facts = await extract({
      ...baseInput,
      categories: new Set() as ReadonlySet<'administrative' | 'financial'>,
    })
    expect(facts).toEqual([])
  })

  // ─── Markdown fence resiliency (production bug observed in PR #30) ─────────
  // Haiku ignorou "Sem texto antes ou depois do JSON" e envolveu o output em
  // ```json ... ```. JSON.parse direto falhava → worker FAILED no Inngest.

  it('parser strips ```json...``` fence (Haiku real output em prod)', async () => {
    const fencedRaw = '```json\n{"facts":[{"category":"administrative","key":"preferred_name","value":"Gabriel","confidence":1.0}]}\n```'
    const extract = createFactsExtractor({ apiKey: 'test', fetch: fakeFetch(fencedRaw) })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ key: 'preferred_name', value: 'Gabriel' })
  })

  it('parser strips ```...``` fence sem language tag', async () => {
    const fencedRaw = '```\n{"facts":[{"category":"administrative","key":"preferred_name","value":"X","confidence":0.8}]}\n```'
    const extract = createFactsExtractor({ apiKey: 'test', fetch: fakeFetch(fencedRaw) })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(1)
  })

  it('parser fallback extrai JSON entre { primeiro } último (texto explicativo antes/depois)', async () => {
    const noisyRaw = 'Aqui está a extração:\n{"facts":[{"category":"administrative","key":"preferred_name","value":"X","confidence":0.8}]}\nFim.'
    const extract = createFactsExtractor({ apiKey: 'test', fetch: fakeFetch(noisyRaw) })
    const facts = await extract(baseInput)
    expect(facts).toHaveLength(1)
  })
})

describe('AI-6: extractJsonObject (unit)', () => {
  it('JSON limpo passa inalterado', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('strips ```json fence completo', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips ``` fence sem language', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips fence só de abertura (LLM truncou closing)', () => {
    expect(extractJsonObject('```json\n{"a":1}')).toBe('{"a":1}')
  })

  it('fallback extrai entre { ... } com texto envolto', () => {
    expect(extractJsonObject('algo antes {"a":1} algo depois')).toBe('{"a":1}')
  })

  it('retorna trimmed quando sem nada parecido com JSON', () => {
    expect(extractJsonObject('  no json here  ')).toBe('no json here')
  })

  it('case-insensitive ```JSON', () => {
    expect(extractJsonObject('```JSON\n{"a":1}\n```')).toBe('{"a":1}')
  })
})
