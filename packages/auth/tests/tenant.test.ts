// packages/auth/tests/tenant.test.ts
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertTenantAccess, listUserClinics } from '../src/tenant.js';
import { TenantAccessDeniedError } from '../src/errors.js';

// ─── Mock helpers ────────────────────────────────────────────────────────────
//
// makeMockSupabase returns a fake Supabase client that responds to .from(table)
// calls with the pre-configured data. The chain supports both patterns:
//   a) await client.from('t').select().eq().maybeSingle()  → single row
//   b) await client.from('t').select()                     → array of rows
//
type MockResult = { data: unknown; error: unknown };

function makeMockSupabase(byTable: Record<string, MockResult>): SupabaseClient {
  const makeChain = (result: MockResult) => {
    const chain: Record<string, unknown> = {};
    chain['select'] = (_cols: string) => chain;
    chain['eq'] = (_col: string, _val: unknown) => chain;
    chain['is'] = (_col: string, _val: unknown) => chain;
    chain['maybeSingle'] = () => Promise.resolve(result);
    chain['then'] = <T>(
      resolve: (value: MockResult) => T,
      reject?: (reason: unknown) => T,
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  };
  return {
    from: (table: string) =>
      makeChain(byTable[table] ?? { data: null, error: null }),
  } as unknown as SupabaseClient;
}

// ─── assertTenantAccess ───────────────────────────────────────────────────────

describe('assertTenantAccess', () => {
  it('returns ClinicSummary when user is a member of the clinic', async () => {
    const supabase = makeMockSupabase({
      clinics: {
        data: { id: 'clinic-1', slug: 'test-clinic', name: 'Test Clinic' },
        error: null,
      },
      clinic_members: {
        data: { role: 'admin' },
        error: null,
      },
    });

    const result = await assertTenantAccess(supabase, 'test-clinic');

    expect(result).toEqual({
      id: 'clinic-1',
      slug: 'test-clinic',
      name: 'Test Clinic',
      role: 'admin',
    });
  });

  it('throws TenantAccessDeniedError when user is NOT a member (RLS returns 0 rows)', async () => {
    const supabase = makeMockSupabase({
      clinics: { data: null, error: null }, // RLS filtered it out
      clinic_members: { data: null, error: null },
    });

    await expect(assertTenantAccess(supabase, 'some-clinic')).rejects.toThrow(
      TenantAccessDeniedError,
    );
  });

  it('throws TenantAccessDeniedError when slug does not exist', async () => {
    const supabase = makeMockSupabase({
      clinics: { data: null, error: null }, // not found
      clinic_members: { data: null, error: null },
    });

    await expect(assertTenantAccess(supabase, 'ghost-clinic')).rejects.toThrow(
      TenantAccessDeniedError,
    );
  });
});

// ─── listUserClinics ──────────────────────────────────────────────────────────

describe('listUserClinics', () => {
  it('returns ClinicSummary[] for all clinics the user belongs to', async () => {
    const supabase = makeMockSupabase({
      clinic_members: {
        data: [
          { role: 'owner', clinics: { id: 'c1', slug: 'clinic-a', name: 'Clinic A' } },
          { role: 'member', clinics: { id: 'c2', slug: 'clinic-b', name: 'Clinic B' } },
        ],
        error: null,
      },
    });

    const result = await listUserClinics(supabase);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'c1', slug: 'clinic-a', name: 'Clinic A', role: 'owner' });
    expect(result[1]).toEqual({ id: 'c2', slug: 'clinic-b', name: 'Clinic B', role: 'member' });
  });

  it('returns empty array for a user with no clinic memberships', async () => {
    const supabase = makeMockSupabase({
      clinic_members: { data: [], error: null },
    });

    const result = await listUserClinics(supabase);

    expect(result).toEqual([]);
  });
});
