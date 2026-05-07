import { describe, it, expect } from 'vitest';
import { getEscalationBadgeProps } from './escalation-badge';

describe('getEscalationBadgeProps', () => {
  it('returns AI badge props with luma-accent color when escalatedVia="ai"', () => {
    const props = getEscalationBadgeProps('ai');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('IA escalou');
    expect(props!.label).toContain('🤖');
    expect(props!.title.toLowerCase()).toContain('ia');
    expect(props!.className).toContain('--luma-accent');
  });

  it('returns manual badge props with luma-text-secondary color when escalatedVia="manual"', () => {
    const props = getEscalationBadgeProps('manual');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Atendente assumiu');
    expect(props!.label).toContain('👤');
    expect(props!.title.toLowerCase()).toContain('atendente');
    expect(props!.className).toContain('--luma-text-secondary');
  });

  it('returns null when escalatedVia is null', () => {
    expect(getEscalationBadgeProps(null)).toBeNull();
  });
});
