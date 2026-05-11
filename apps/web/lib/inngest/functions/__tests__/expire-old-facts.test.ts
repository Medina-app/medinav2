import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expireOldFactsHandler, type ExpireOldFactsDeps } from '../expire-old-facts';

function makeSupabase(rpcResult: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  return {
    sb: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

function makeDeps(sb: SupabaseClient, batchLimit?: number): ExpireOldFactsDeps {
  return { supabase: sb, batchLimit };
}

describe('expireOldFactsHandler', () => {
  it('chama RPC expire_old_patient_facts com p_batch_limit default (1000)', async () => {
    const { sb, rpc } = makeSupabase({ data: 42, error: null });
    const result = await expireOldFactsHandler(makeDeps(sb));
    expect(rpc).toHaveBeenCalledWith('expire_old_patient_facts', { p_batch_limit: 1000 });
    expect(result).toEqual({ expired: 42 });
  });

  it('passa batchLimit customizado para o RPC', async () => {
    const { sb, rpc } = makeSupabase({ data: 7, error: null });
    await expireOldFactsHandler(makeDeps(sb, 500));
    expect(rpc).toHaveBeenCalledWith('expire_old_patient_facts', { p_batch_limit: 500 });
  });

  it('retorna {expired: 0} quando RPC retorna 0', async () => {
    const { sb } = makeSupabase({ data: 0, error: null });
    const result = await expireOldFactsHandler(makeDeps(sb));
    expect(result).toEqual({ expired: 0 });
  });

  it('throws quando RPC retorna erro (Inngest retries cron na próxima execução)', async () => {
    const { sb } = makeSupabase({
      data: null,
      error: { message: 'function expire_old_patient_facts does not exist' },
    });
    await expect(expireOldFactsHandler(makeDeps(sb))).rejects.toThrow(/does not exist/);
  });

  it('retorna {expired: 0} quando RPC retorna non-number (defensivo)', async () => {
    const { sb } = makeSupabase({ data: null, error: null });
    const result = await expireOldFactsHandler(makeDeps(sb));
    expect(result).toEqual({ expired: 0 });
  });
});
