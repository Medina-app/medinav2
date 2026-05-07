/**
 * Returns visual props for the escalation badge in the inbox header.
 *
 * 'ai'     → "🤖 IA escalou" (luma-accent — atenção, IA-driven)
 * 'manual' → "👤 Atendente assumiu" (luma-text-secondary — neutro)
 * null     → null (sem badge)
 *
 * Pure function — testable without jsdom; consumed by conversation-detail.tsx.
 */

export type EscalatedVia = 'ai' | 'manual' | null;

export interface EscalationBadgeProps {
  label: string;
  title: string;
  className: string;
}

const BASE = 'text-[11px] font-medium bg-[var(--luma-bg-subtle)] rounded-full px-2.5 py-0.5';

export function getEscalationBadgeProps(v: EscalatedVia): EscalationBadgeProps | null {
  if (v === 'ai') {
    return {
      label: '🤖 IA escalou',
      title: 'A IA detectou que precisa de humano e escalou',
      className: `${BASE} text-[var(--luma-accent)]`,
    };
  }
  if (v === 'manual') {
    return {
      label: '👤 Atendente assumiu',
      title: 'Atendente desligou IA manualmente',
      className: `${BASE} text-[var(--luma-text-secondary)]`,
    };
  }
  return null;
}
