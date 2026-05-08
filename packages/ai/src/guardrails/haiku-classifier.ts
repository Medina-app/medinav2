/**
 * AI-5 — Haiku classifier (camada 2 do urgency-detector).
 *
 * Fallback OpenRouter direto (HTTP, sem Mastra) pro caso de regex
 * inconclusiva. Modelo `anthropic/claude-haiku-4-5` — confirmado
 * disponível no OpenRouter (test em Task 0: ~$0.000031/call, latência
 * 0.5-1.5s 95p).
 *
 * Output force-formatado JSON {level, category} via system prompt curto.
 * Erros/timeout do classifier são swallowed pelo urgency-detector
 * (fallback level='medium'); aqui só lançamos com mensagem descritiva.
 *
 * NÃO usar Mastra Agent.generate aqui — Mastra carrega persistente storage,
 * tools, memory; queremos chamada one-shot de baixa latência. Direct fetch
 * é o caminho mínimo.
 */

import type { LlmClassify } from './urgency-detector.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const HAIKU_MODEL = 'anthropic/claude-haiku-4-5'

const SYSTEM_PROMPT = `Você é um classificador de urgência médica vital pra mensagens de pacientes em PT-BR. Sua tarefa: ler a mensagem e responder SOMENTE um JSON minificado no formato {"level":"low|medium|critical","category":"suicide|bleeding|cardiac|trauma|other_critical|none"}.

- level=critical: risco vital imediato (ideação suicida ativa, sangramento intenso, dor cardíaca, trauma grave).
- level=medium: situação preocupante mas sem risco vital imediato (dor moderada, sintomas persistentes).
- level=low: pergunta administrativa, saudação, small talk, agendamento.

Responda APENAS o JSON. Sem texto antes ou depois.`

/** Whitelist de categorias aceitas do classifier. Mantém alinhada com o
 *  SYSTEM_PROMPT acima — qualquer string fora desse set é descartada
 *  silenciosamente (defense in depth contra LLM desobedecendo prompt). */
const ALLOWED_CATEGORIES: ReadonlySet<string> = new Set([
  'suicide',
  'bleeding',
  'cardiac',
  'trauma',
  'other_critical',
  'none',
])

interface OpenRouterChoice {
  message?: { content?: string }
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
}

/**
 * Cria um LlmClassify usando OpenRouter Haiku. apiKey lida do env por
 * default (igual agent-factory.ts:resolveModel) — caller pode override.
 */
export function createHaikuClassifier(opts: {
  apiKey?: string
  model?: string
  fetch?: typeof fetch
} = {}): LlmClassify {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error('createHaikuClassifier: OPENROUTER_API_KEY not set')
  }
  const model = opts.model ?? HAIKU_MODEL
  const doFetch = opts.fetch ?? fetch

  return async (content: string) => {
    const res = await doFetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        max_tokens: 60,
        temperature: 0,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '<no-body>')
      throw new Error(`Haiku classifier HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const json = (await res.json()) as OpenRouterResponse
    const raw = json.choices?.[0]?.message?.content?.trim() ?? ''
    if (!raw) {
      throw new Error('Haiku classifier returned empty content')
    }
    let parsed: { level?: string; category?: string }
    try {
      parsed = JSON.parse(raw) as { level?: string; category?: string }
    } catch {
      throw new Error(`Haiku classifier returned non-JSON: ${raw.slice(0, 200)}`)
    }
    const level = parsed.level
    if (level !== 'low' && level !== 'medium' && level !== 'critical') {
      throw new Error(`Haiku classifier returned invalid level: ${String(level)}`)
    }
    // Whitelist category contra ALLOWED_CATEGORIES (CodeRabbit nitpick #4):
    // LLM desobedecendo SYSTEM_PROMPT pode retornar qualquer string. Em vez
    // de propagar valor não confiável pra UrgencyResult.category (que vai pra
    // logs/spans/audit), descartamos silenciosamente. 'none' já era ignorado.
    const rawCategory = parsed.category
    const validCategory =
      typeof rawCategory === 'string' &&
      rawCategory !== 'none' &&
      ALLOWED_CATEGORIES.has(rawCategory)
        ? rawCategory
        : undefined
    return {
      level,
      ...(validCategory ? { category: validCategory } : {}),
    }
  }
}
