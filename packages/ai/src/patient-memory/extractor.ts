/**
 * AI-6 — Haiku-based extractor de fatos administrativos/financeiros sobre
 * paciente. Roda no fim da conversa (estado waiting_human ou resolved).
 *
 * Pattern: OpenRouter direto via fetch (sem Mastra Agent — call one-shot,
 * baixa latência, sem tools). Mimicar guardrails/haiku-classifier.ts.
 *
 * Defense in depth:
 *  1. SYSTEM_PROMPT proíbe explicitamente facts médicos
 *  2. Zod valida shape do output
 *  3. Whitelist de keys por categoria (ALLOWED_KEYS) descarta keys inventadas
 *  4. Filtro de categorias habilitadas pela clínica
 *  5. Blocklist regex no value descarta PHI escapando como fato adm
 */

import {
  ALLOWED_KEYS,
  ExtractionOutputSchema,
  MEDICAL_BLOCKLIST_RE,
  type ExtractedFact,
  type FactCategory,
} from './types.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const HAIKU_MODEL = 'anthropic/claude-haiku-4-5'

const SYSTEM_PROMPT = `Você extrai fatos administrativos e financeiros não-médicos sobre um paciente, a partir de mensagens trocadas com um agente de atendimento clínico em PT-BR.

REGRAS ABSOLUTAS:
1. NUNCA extraia: sintomas, diagnósticos, queixas de saúde, medicações, alergias, dor, gravidez, doenças, exames, condições médicas.
2. Extraia APENAS quando o paciente declarar explicitamente (sem inferir).
3. Categorias e keys permitidas:
   - administrative: preferred_name, full_name, age, profession, address_neighborhood
   - financial: health_plan_name, preferred_payment_method
4. Para cada fact, dê uma confidence entre 0 e 1 baseada em quão explícita foi a menção.

Responda SOMENTE com JSON minificado no formato:
{"facts":[{"category":"administrative|financial","key":"...","value":"...","confidence":0.0-1.0}]}

Se nada foi declarado explicitamente, responda {"facts":[]}.
Sem texto antes ou depois do JSON.`

interface OpenRouterChoice {
  message?: { content?: string }
}
interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
}

export interface ExtractFactsOpts {
  apiKey?: string
  model?: string
  fetch?: typeof fetch
  /** Max tokens da resposta (limita custo). Default 400 cobre ~10 facts. */
  maxTokens?: number
}

export interface ExtractInput {
  /** Mensagens da conversa, oldest-first. Só user messages alimentam extração. */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  /** Categorias habilitadas pela clínica. Set vazio → retorna [] sem chamar Haiku. */
  categories: ReadonlySet<FactCategory>
}

export type FactsExtractor = (input: ExtractInput) => Promise<ExtractedFact[]>

export function createFactsExtractor(opts: ExtractFactsOpts = {}): FactsExtractor {
  const apiKey = opts.apiKey ?? process.env['OPENROUTER_API_KEY']
  if (!apiKey) {
    throw new Error('createFactsExtractor: OPENROUTER_API_KEY not set')
  }
  const model = opts.model ?? HAIKU_MODEL
  const doFetch = opts.fetch ?? fetch
  const maxTokens = opts.maxTokens ?? 400

  return async (input: ExtractInput) => {
    if (input.categories.size === 0) {
      return []
    }

    const transcript = input.messages
      .filter((m) => m.role === 'user' && m.content.trim().length > 0)
      .map((m) => `Paciente: ${m.content}`)
      .join('\n')

    if (transcript.length === 0) {
      return []
    }

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
          { role: 'user', content: transcript },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '<no-body>')
      throw new Error(`Facts extractor HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const json = (await res.json()) as OpenRouterResponse
    const raw = json.choices?.[0]?.message?.content?.trim() ?? ''
    if (!raw) {
      throw new Error('Facts extractor returned empty content')
    }

    // Defense in depth contra LLM ignorando o "Sem texto antes ou depois do
    // JSON" do system prompt: Haiku às vezes envolve em ```json ... ``` ou
    // adiciona texto explicativo. extractJsonObject normaliza.
    const cleaned = extractJsonObject(raw)
    let parsedRaw: unknown
    try {
      parsedRaw = JSON.parse(cleaned)
    } catch {
      throw new Error(`Facts extractor returned non-JSON: ${raw.slice(0, 200)}`)
    }

    const parsed = ExtractionOutputSchema.safeParse(parsedRaw)
    if (!parsed.success) {
      // LLM desobedeceu shape — log silent + return []. Não throw porque
      // queremos extração ser fire-and-forget no worker (não bloqueia outras tarefas).
      // Se quisermos visibilidade: caller pode wrappar em try/catch.
      return []
    }

    return parsed.data.facts.filter((fact) =>
      isFactAllowed(fact, input.categories),
    )
  }
}

/**
 * Normaliza output do LLM removendo markdown code fences (```json ... ```)
 * e qualquer texto fora do primeiro objeto JSON. Caso o LLM responda
 * apenas com JSON limpo, retorna inalterado.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim()
  // Path feliz: já é JSON limpo começando com {
  if (trimmed.startsWith('{')) {
    return trimmed
  }
  // Markdown fence: ```json\n{...}\n``` ou ```\n{...}\n```
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i)
  if (fenced && fenced[1]) {
    return fenced[1].trim()
  }
  // Fence só no início (LLM cortou antes do close): ```json\n{...}
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim()
  }
  // Fallback: extrai do primeiro { até o último } (texto antes/depois ignorado).
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1)
  }
  return trimmed
}

function isFactAllowed(fact: ExtractedFact, enabled: ReadonlySet<FactCategory>): boolean {
  if (!enabled.has(fact.category)) return false
  const allowedKeys = ALLOWED_KEYS[fact.category]
  if (!allowedKeys.has(fact.key)) return false
  if (MEDICAL_BLOCKLIST_RE.test(fact.value)) return false
  return true
}
