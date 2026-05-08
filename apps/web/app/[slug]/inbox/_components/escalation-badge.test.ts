import { describe, it, expect } from 'vitest';
import { getEscalationBadgeProps } from './escalation-badge';

describe('getEscalationBadgeProps', () => {
  it('returns AI badge props with luma-accent color when escalatedVia="ai" + reason=null', () => {
    const props = getEscalationBadgeProps('ai', null);
    expect(props).not.toBeNull();
    expect(props!.label).toContain('IA escalou');
    expect(props!.label).toContain('🤖');
    expect(props!.title.toLowerCase()).toContain('ia');
    expect(props!.className).toContain('--luma-accent');
  });

  it('returns manual badge props with luma-text-secondary color when escalatedVia="manual"', () => {
    const props = getEscalationBadgeProps('manual', null);
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Atendente assumiu');
    expect(props!.label).toContain('👤');
    expect(props!.title.toLowerCase()).toContain('atendente');
    expect(props!.className).toContain('--luma-text-secondary');
  });

  it('returns null when escalatedVia is null', () => {
    expect(getEscalationBadgeProps(null, null)).toBeNull();
  });

  // ─── AI-5: guardrail-driven escalation badge variant ──────────────────────

  it('returns guardrail badge "🛡️ IA escalou (Medicação)" when reason="medication"', () => {
    const props = getEscalationBadgeProps('ai', 'medication');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('🛡️');
    expect(props!.label).toContain('IA escalou');
    expect(props!.label).toContain('Medicação');
    expect(props!.title.toLowerCase()).toMatch(/guardrail|medicação/);
  });

  it('returns guardrail variants pra todas as 5 categorias do enum', () => {
    const cases: Array<[NonNullable<Parameters<typeof getEscalationBadgeProps>[1]>, string]> = [
      ['medication', 'Medicação'],
      ['diagnosis', 'Diagnóstico'],
      ['urgency', 'Urgência'],
      ['symptom', 'Sintoma'],
      ['other', 'Outro'],
    ];
    for (const [reason, label] of cases) {
      const props = getEscalationBadgeProps('ai', reason);
      expect(props, `reason=${reason}`).not.toBeNull();
      expect(props!.label, `reason=${reason}`).toContain(label);
      expect(props!.label, `reason=${reason}`).toContain('🛡️');
    }
  });

  it('reason ignored quando escalatedVia="manual" (badge manual prevalece)', () => {
    // Quando atendente desliga IA, badge sempre é "👤 Atendente assumiu"
    // mesmo se historicamente houve guardrail anterior. escalated_reason
    // pode estar persistido mas via='manual' tem prioridade visual.
    const props = getEscalationBadgeProps('manual', 'medication');
    expect(props!.label).toContain('Atendente assumiu');
    expect(props!.label).not.toContain('🛡️');
  });

  it('reason ignored quando escalatedVia=null', () => {
    // Defesa contra estado inconsistente (reason populado, via null) — sem badge.
    expect(getEscalationBadgeProps(null, 'medication')).toBeNull();
  });
});
