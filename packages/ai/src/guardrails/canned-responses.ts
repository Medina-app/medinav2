/**
 * AI-5 — Canned responses para escalação por guardrail.
 *
 * Regra invariante: paciente NUNCA fica sem resposta. Quando pre-filter
 * ou urgency-detector dispara, dispatcher pula o LLM e envia uma destas
 * respostas pré-definidas, depois aciona escalate_conversation_with_reason.
 *
 * Critérios:
 *   - Tom curto, claro, em PT-BR coloquial (matches Luma voice).
 *   - Sempre comunica handoff humano explícito (paciente não fica achando
 *     que mandou pra um buraco).
 *   - Defense-in-depth: NENHUMA resposta aqui pode violar os próprios
 *     blocked patterns (test "validateOutput retorna valid:true em todas").
 *   - Não menciona medicamento específico nem doença específica (mesmo
 *     em diagnostic_advice — IA não sugere "ir ao médico" porque isso
 *     já é diagnostic_advice; em vez disso, oferece marcar consulta).
 *
 * Urgency é o caso especial: além de comunicar handoff, oferece os
 * números públicos brasileiros (CVV 188 — Centro de Valorização da Vida,
 * 24h gratuito; SAMU 192 — emergência médica). CVV é específico pra
 * sofrimento emocional/suicídio mas a referência ao número é defendida
 * pra qualquer urgência reportada (paciente em risco vital pode estar
 * múltiplas situações).
 */

import type { EscalatedReason } from './types.js'

const RESPONSES: Record<EscalatedReason, string> = {
  medication: 'Posso te ajudar a marcar uma consulta pra avaliação, mas a indicação de medicação precisa de avaliação presencial com profissional. Vou te transferir pra um atendente humano agora.',

  diagnosis: 'Sou a secretária virtual e não posso avaliar quadro clínico. Posso te ajudar a marcar uma consulta — vou te transferir pra um atendente humano agora.',

  urgency: 'Detectei que você pode estar passando por algo sério. Já estou chamando uma pessoa do nosso time pra te atender agora. Em emergência, ligue SAMU 192. Se você está em sofrimento emocional, o CVV atende 24h pelo 188 (gratuito).',

  symptom: 'Pra avaliar sintomas com cuidado, é melhor falar diretamente com nosso time. Vou te transferir pra um atendente humano agora.',

  other: 'Vou te transferir pra um atendente humano dar continuidade.',
}

/** Retorna a resposta canned pra uma categoria de escalação. Sempre não-vazia. */
export function getCannedResponse(reason: EscalatedReason): string {
  return RESPONSES[reason]
}
