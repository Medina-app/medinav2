import { describe, it, expect } from 'vitest';
import { getKbStatusBadge } from './kb-status-badge';

describe('getKbStatusBadge', () => {
  it('retorna badge "Indexado" verde pra status=indexed', () => {
    const props = getKbStatusBadge('indexed');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Indexado');
    expect(props!.label).toContain('✓');
    expect(props!.className).toContain('luma-success');
  });

  it('retorna badge "Processando" pra status=pending', () => {
    const props = getKbStatusBadge('pending');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Processando');
    expect(props!.label).toContain('⏳');
    expect(props!.className).toContain('luma-text-secondary');
  });

  it('retorna badge "Processando" pra status=processing', () => {
    const props = getKbStatusBadge('processing');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Processando');
  });

  it('retorna badge "Falhou" vermelho com title=errorMessage pra status=failed', () => {
    const props = getKbStatusBadge('failed', 'OpenAI rate limit');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Falhou');
    expect(props!.label).toContain('✗');
    expect(props!.className).toContain('luma-danger');
    expect(props!.title).toContain('OpenAI rate limit');
  });

  it('retorna badge "Falhou" sem title quando errorMessage ausente', () => {
    const props = getKbStatusBadge('failed');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Falhou');
    // Title fallback genérico — não null mas não menciona detalhes específicos.
    expect(props!.title).toBeTruthy();
  });

  it('retorna null pra status=archived (não exibir badge — UI já filtra archived da lista)', () => {
    expect(getKbStatusBadge('archived')).toBeNull();
  });

  it('retorna null pra status desconhecido (defensive)', () => {
    expect(getKbStatusBadge('weird-state' as never)).toBeNull();
  });

  // ── Approval-status precedence (AI-3.5b) ────────────────────────────────
  it('approval=pending_approval tem precedência sobre status, mostra ⏸ Aguardando aprovação (warning)', () => {
    const props = getKbStatusBadge('pending', null, 'pending_approval');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Aguardando aprovação');
    expect(props!.label).toContain('⏸');
    expect(props!.className).toContain('luma-warning');
  });

  it('approval=rejected tem precedência sobre status, mostra ⊘ Rejeitado (text-tertiary)', () => {
    const props = getKbStatusBadge('pending', null, 'rejected');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Rejeitado');
    expect(props!.label).toContain('⊘');
    expect(props!.className).toContain('luma-text-tertiary');
  });

  it('approval=rejected inclui motivo no title quando errorMessage informado', () => {
    const props = getKbStatusBadge('failed', 'Conteúdo fora de escopo clínico', 'rejected');
    expect(props!.title).toContain('Conteúdo fora de escopo clínico');
  });

  it('approval=approved + status=indexed cai pro pipeline normal (✓ Indexado)', () => {
    const props = getKbStatusBadge('indexed', null, 'approved');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Indexado');
    expect(props!.className).toContain('luma-success');
  });

  it('approval=approved + status=processing cai pro pipeline normal (⏳ Processando)', () => {
    const props = getKbStatusBadge('processing', null, 'approved');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Processando');
  });

  it('back-compat: sem approvalStatus continua funcionando (defaulta pro pipeline de status)', () => {
    const props = getKbStatusBadge('indexed');
    expect(props).not.toBeNull();
    expect(props!.label).toContain('Indexado');
  });
});
