/**
 * Returns visual props for the escalation badge in the inbox header.
 *
 * Variantes (em ordem de prioridade):
 *   - via='ai'  + reason!=null → "🛡️ IA escalou (Categoria)" (luma-accent)
 *     [AI-5: guardrail-driven escalation, categoria estruturada do DB]
 *   - via='ai'  + reason=null  → "🤖 IA escalou" (luma-accent)
 *     [PR-A: tool-call escalation via escalate_to_human, free-text reason]
 *   - via='manual'             → "👤 Atendente assumiu" (luma-text-secondary)
 *     [PR-A: atendente toggleou IA off; reason ignorado por design]
 *   - via=null                 → null (sem badge)
 *
 * Pure function — testable without jsdom; consumed por conversation-detail.tsx.
 */

export type EscalatedVia = 'ai' | 'manual' | null;
export type EscalatedReason =
  | 'medication'
  | 'diagnosis'
  | 'urgency'
  | 'symptom'
  | 'other'
  | null;

export interface EscalationBadgeProps {
  label: string;
  title: string;
  className: string;
}

const BASE = 'text-[11px] font-medium bg-[var(--luma-bg-subtle)] rounded-full px-2.5 py-0.5';

const REASON_LABEL: Record<NonNullable<EscalatedReason>, string> = {
  medication: 'Medicação',
  diagnosis: 'Diagnóstico',
  urgency: 'Urgência',
  symptom: 'Sintoma',
  other: 'Outro',
};

const REASON_TITLE: Record<NonNullable<EscalatedReason>, string> = {
  medication: 'Guardrail disparou: paciente pediu medicação',
  diagnosis: 'Guardrail disparou: paciente pediu diagnóstico',
  urgency: 'Guardrail disparou: urgência médica detectada',
  symptom: 'Guardrail disparou: interpretação de sintoma',
  other: 'Guardrail disparou: política da clínica',
};

export function getEscalationBadgeProps(
  via: EscalatedVia,
  reason: EscalatedReason,
): EscalationBadgeProps | null {
  if (via === 'ai') {
    if (reason) {
      return {
        label: `🛡️ IA escalou (${REASON_LABEL[reason]})`,
        title: REASON_TITLE[reason],
        className: `${BASE} text-[var(--luma-accent)]`,
      };
    }
    return {
      label: '🤖 IA escalou',
      title: 'A IA detectou que precisa de humano e escalou',
      className: `${BASE} text-[var(--luma-accent)]`,
    };
  }
  if (via === 'manual') {
    return {
      label: '👤 Atendente assumiu',
      title: 'Atendente desligou IA manualmente',
      className: `${BASE} text-[var(--luma-text-secondary)]`,
    };
  }
  return null;
}
