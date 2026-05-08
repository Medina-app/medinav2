/**
 * AI-5 — Default guardrail patterns (PT-BR) + mergeGuardrails().
 *
 * # Convenções dos patterns
 * - Case-insensitive via flag /i (LLM/paciente PT-BR mistura caixa).
 * - Acentos opcionais via classes [eé], [aã], [cç] onde a coloquialidade
 *   removeria o diacrítico ("nao aguento" vs "não aguento").
 * - \b word boundary onde aplicável pra evitar matchear substrings ("infecção"
 *   matchear "infecções" é desejado, mas "câncer" matchear "cancerizar" não é
 *   relevante na prática).
 *
 * # Tradeoffs FP/FN documentados
 * Este sistema prefere FALSOS POSITIVOS a falsos negativos. Toda escalação
 * passa o paciente pra atendente humano que avalia — custo de FP é uma
 * conversa extra; custo de FN é dado de saúde sem oversight humano (LGPD)
 * ou pior, ato médico por IA (CFM Res 2.314/2022).
 *
 * Casos conhecidos de FP aceitos:
 * - "estava sangrando muito mas parou" → bleeding (escala — humano avalia)
 * - "tenho diabetes faz anos" → diagnosis_request (mas verbo "tenho" + doença
 *   sem verbo de pergunta NÃO matcha; relato puro passa direto)
 * - "tomei dipirona ontem" → medication_request? Não — não tem verbo de
 *   intenção ("posso tomar", "devo tomar"). Relato passa direto.
 *
 * Casos conhecidos de FN aceitos (cobrir via LLM post-filter ou clinic
 * override em additional_*_patterns):
 * - Frases muito coloquiais com gírias regionais
 * - Eufemismos pra suicídio ("acabar com tudo", "sumir") — fica pro Haiku
 *   classifier no urgency-detector
 *
 * # Estrutura
 * - DEFAULT_BLOCKED_PATTERNS: usuário pediu coisa que LLM não pode responder
 *   (medicação/diagnóstico/conduta). Pre-filter dispara → escalate.
 * - DEFAULT_URGENT_PATTERNS: risco vital/iminente. Urgency-detector dispara
 *   IMEDIATA escalation com canned response (CVV 188 em suicide etc).
 * - symptom_interpretation NÃO é default — alta taxa de FP em PT-BR coloquial
 *   ("tô com uma dorzinha"). Disponível via additional_blocked_patterns pra
 *   clínicas que quiserem opt-in.
 */

import type { GuardrailsConfig } from './types.js'

/**
 * Lista de doenças/condições reconhecidas em PT-BR coloquial. Usada em 2
 * patterns de diagnosis_request: a forma user-shape ("é alergia?") e a
 * forma LLM-shape ("você tem alergia"). DRY single source of truth — adicionar
 * doença aqui propaga pros 2 sites.
 */
const DISEASE_LIST =
  'alergia|gripe|dengue|covid|virose|gastrite|refluxo|infec[cç][aã]o|infec[cç][oõ]es|enxaqueca|c[aâ]ncer|tumor|sinusite|amigdalite|bronquite|asma|pneumonia|labirintite|diabete[s]?|infarto|enfarte|av[ce]|press[aã]o (alta|baixa)'

/**
 * Lista de classes terapêuticas + medicamentos comuns que LLM pode acabar
 * recomendando. Inclui princípios ativos populares (dipirona, paracetamol,
 * ibuprofeno) + classes (antibiótico, analgésico).
 */
const MED_LIST =
  'rem[eé]dio|medicamento|antibi[oó]tico|analg[eé]sico|anti[- ]?inflamat[oó]rio|dipirona|paracetamol|ibuprofeno|amoxicilina|nimesulida|omeprazol|losartana'

export const DEFAULT_BLOCKED_PATTERNS: Record<string, RegExp[]> = {
  diagnosis_request: [
    // ─── User-shape (interrogativo) ─────────────────────────────────────────
    // "o que tenho", "o que eu tenho", "o que será que tenho"
    /\bo que (eu )?(tenho|ser[aá] que tenho)\b/i,
    // "qual minha doença", "qual a doença", "que doença é essa"
    /\b(qual (é |e )?(minha|a) doen[cç]a|que doen[cç]a)\b/i,
    // Severity probes: "isso é grave/sério/preocupante"
    /\bisso (e|é) (grave|s[eé]rio|s[eé]ria|preocupante)\b/i,
    // "é alergia?", "é dengue?", "é câncer?" (qualquer doença da DISEASE_LIST)
    // Anchor com (?:^|\s) em vez de \b porque 'é' não é \w em regex JS (sem flag /u)
    // — \bé não casa quando precedido por espaço/início; whitespace/start é robusto.
    new RegExp(`(?:^|\\s)(e|é) (uma |um )?(${DISEASE_LIST})\\b`, 'i'),
    // ─── LLM-shape (declarativo) ────────────────────────────────────────────
    // "você tem alergia", "você está com gripe", "você sofre de diabetes"
    new RegExp(`\\bvocê (tem|est[aá] com|sofre de) (uma |um )?(${DISEASE_LIST})\\b`, 'i'),
    // "parece (ser) uma alergia", "parece dengue"
    new RegExp(`\\bparece (ser )?(uma |um )?(${DISEASE_LIST})\\b`, 'i'),
    // "diagnóstico é/de", "prognóstico é/de"
    /\b(diagn[oó]stico|progn[oó]stico) (é|de)\b/i,
  ],
  medication_request: [
    // ─── User-shape (interrogativo) ─────────────────────────────────────────
    // "qual remédio devo tomar", "que medicamento posso tomar"
    /\b(qual|que) (rem[eé]dio|medicamento) (devo|posso|tenho que) tomar\b/i,
    // "posso tomar dipirona/algum remédio/antibiótico"
    new RegExp(
      `\\b(posso|devo) tomar (algum|um|o |a |esse |esses )?(${MED_LIST})\\b`,
      'i',
    ),
    // "me indica algum remédio"
    /\bme (indica|indique|recomenda|prescreve) (algum |um )?(rem[eé]dio|medicamento)\b/i,
    // Dosage questions: "qual a dosagem", "quantos mg"
    /\b(qual (a |o )?dosagem|quantos? mg|quantas? gotas)\b/i,
    // ─── LLM-shape (declarativo) ────────────────────────────────────────────
    // "você pode tomar paracetamol", "deve tomar dipirona"
    new RegExp(
      `\\b(você )?(pode|deve|deveria) tomar (uma |um )?(${MED_LIST})\\b`,
      'i',
    ),
    // "recomendo dipirona", "recomendo que tome", "sugiro paracetamol"
    new RegExp(
      `\\b(recomendo|sugiro|indico) (que (você )?(tome|use)|tomar|usar)?(.*?)?(${MED_LIST})\\b`,
      'i',
    ),
    // "tome 1 comprimido/gotas", "use 5 ml"
    /\b(tome|use) (\d+|uma|um|umas|uns) (comprimidos?|gotas|c[aá]psulas?|ml|sachês?|colheres?)\b/i,
    // Prescrição com dosagem inline: "paracetamol 500mg", "dipirona 1g"
    new RegExp(`\\b(${MED_LIST}) \\d+ ?(mg|g|ml|gotas)\\b`, 'i'),
  ],
  diagnostic_advice: [
    // "é normal/anormal/preocupante" (questão clínica de avaliação)
    // Mesmo motivo do anchor (?:^|\s): 'é' não é \w em regex JS sem flag /u.
    /(?:^|\s)(e|é) (normal|anormal|preocupante)\b/i,
    // "vai melhorar/piorar/sarar"
    /\bvai (melhorar|piorar|sarar)\b/i,
    // "preciso ir no médico/hospital", "preciso me consultar"
    /\bprecis(o|a|amos) (ir |me )?(consultar|no m[eé]dico|no hospital|no pronto[- ]?socorro)\b/i,
  ],
}

export const DEFAULT_URGENT_PATTERNS: Record<string, RegExp[]> = {
  suicide: [
    /\bvou me matar\b/i,
    /\bquero morrer\b/i,
    /\bn[aã]o aguento (mais|a vida|mais a vida|viver)\b/i,
    /\btomei (\d+|todos os|muitos) (comprimidos|rem[eé]dios|comprimido)\b/i,
    /\bpensando em (me )?(matar|suicidar|tirar (a )?vida)\b/i,
    /\bvou tomar (todos os|muitos) (comprimidos|rem[eé]dios)\b/i,
  ],
  bleeding: [
    /\bsangrando muito\b/i,
    /\bperd(i|endo) (muito )?sangue\b/i,
    /\bhemorragia\b/i,
  ],
  cardiac: [
    /\bdor (forte|intensa|muito forte) no peito\b/i,
    /\bn[aã]o (consigo|estou conseguindo) respirar\b/i,
    /\b(infarto|enfarte|avc|derrame)\b/i,
  ],
  trauma: [
    /\bacidente (grave|de carro|de moto)\b/i,
    /\b(fui )?atropelad[ao]\b/i,
    /\b(fraturei|quebrei (o |a )?(bra[cç]o|perna|costela|p[eé]))\b/i,
  ],
}

export interface MergedPatterns {
  blocked: Record<string, RegExp[]>
  urgent: Record<string, RegExp[]>
}

/**
 * Combina defaults com overrides do agent_config.guardrails (jsonb).
 *
 * - Categorias em disabled_default_categories são REMOVIDAS de blocked + urgent.
 * - additional_blocked/urgent_patterns CONCATENAM com defaults da mesma
 *   categoria (defaults primeiro, overrides depois — não substituem).
 * - additional_*_patterns CRIAM categoria nova quando não existe.
 * - Strings inválidas em additional_* lançam Error com nome da categoria pra
 *   debug rápido (config-side typo crasha loud — ver fix #9 PR-A pattern).
 *
 * Não muta DEFAULTS (cópia rasa via spread; arrays internos são novos).
 */
export function mergeGuardrails(config: GuardrailsConfig): MergedPatterns {
  const blocked: Record<string, RegExp[]> = {}
  const urgent: Record<string, RegExp[]> = {}

  // Cópia rasa dos defaults — copiamos arrays pra evitar push() vazar pra
  // referência global em test isolation.
  for (const [cat, list] of Object.entries(DEFAULT_BLOCKED_PATTERNS)) {
    blocked[cat] = [...list]
  }
  for (const [cat, list] of Object.entries(DEFAULT_URGENT_PATTERNS)) {
    urgent[cat] = [...list]
  }

  // Opt-out: remove de ambos os mapas (mesma categoria pode ser definida
  // só em um, mas o opt-out é unificado por design — clínica sinaliza "não
  // me aplique essa policy" e o sistema cobre os 2 mapas).
  for (const cat of config.disabled_default_categories ?? []) {
    delete blocked[cat]
    delete urgent[cat]
  }

  const compileOrThrow = (cat: string, source: string): RegExp => {
    try {
      return new RegExp(source, 'i')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `mergeGuardrails: invalid regex in category "${cat}": ${source} (${msg})`,
      )
    }
  }

  for (const [cat, patterns] of Object.entries(config.additional_blocked_patterns ?? {})) {
    const compiled = patterns.map((p) => compileOrThrow(cat, p))
    blocked[cat] = [...(blocked[cat] ?? []), ...compiled]
  }
  for (const [cat, patterns] of Object.entries(config.additional_urgent_patterns ?? {})) {
    const compiled = patterns.map((p) => compileOrThrow(cat, p))
    urgent[cat] = [...(urgent[cat] ?? []), ...compiled]
  }

  return { blocked, urgent }
}
