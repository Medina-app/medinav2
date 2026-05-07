import { vi } from 'vitest'
import type { ToolContext } from '../../src/types.js'

type RowSelector = {
  single?: unknown
  maybeSingle?: unknown
  insertResult?: unknown
  /** Resolves `from(table).select().eq()*.in()` to `{ data, error: null }`. */
  inResult?: unknown
}

/**
 * Mock Supabase client supporting the chains tools actually use:
 *   from('X').select(...).eq(...).single() / maybeSingle()
 *   from('X').select(...).eq(...).eq(...).single() / maybeSingle()
 *   from('X').select(...).eq(...).in('col', [...])  (await → { data, error })
 *   from('X').update(...).eq(...).eq(...)            (returns { error })
 *   from('X').insert(...).select(...).single()       (when caller wants the row)
 *   from('X').insert(...)                            (fire-and-forget; returns { error: null })
 *   rpc('fn_name', { args })                          (returns { data, error })
 *
 * Override per-table behavior via `tables` map. Default returns null/no-op.
 *
 * Returns the raw vi.fn() handles so tests can inspect calls AND a typed
 * `supabase` cast as a SupabaseClient placeholder.
 */
export function buildMockSupabase(
  tables: Record<string, RowSelector> = {},
  rpcResult: { data?: unknown; error?: { message: string } | null } = { error: null },
) {
  const rpc = vi.fn().mockResolvedValue(rpcResult)
  const insertCalls: Array<{ table: string; payload: unknown }> = []
  const updateCalls: Array<{ table: string; payload: unknown }> = []

  const from = vi.fn((table: string) => {
    const cfg = tables[table] ?? {}

    // SELECT chain — supports arbitrary .eq() chaining ending with .single() |
    // .maybeSingle() | .in(col, values). The .in() form resolves directly
    // (search_kb uses it to batch-fetch knowledge_documents titles).
    type SelectChain = {
      eq: () => SelectChain
      in: (col: string, values: unknown[]) => Promise<{ data: unknown; error: null }>
      single: ReturnType<typeof vi.fn>
      maybeSingle: ReturnType<typeof vi.fn>
    }
    const selectChain: SelectChain = {
      eq: vi.fn(() => selectChain),
      in: vi.fn((_col: string, _values: unknown[]) =>
        Promise.resolve({ data: cfg.inResult ?? [], error: null as null }),
      ) as SelectChain['in'],
      single: vi.fn().mockResolvedValue({ data: cfg.single ?? null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: cfg.maybeSingle ?? null, error: null }),
    }
    const select = vi.fn(() => selectChain)

    // UPDATE chain — supports .eq().eq() and resolves to { error: null }
    type UpdateChain = { eq: (...a: unknown[]) => Promise<{ error: null }> | UpdateChain }
    const update = vi.fn((payload: unknown) => {
      updateCalls.push({ table, payload })
      const eqResult: UpdateChain = {
        eq: vi.fn((..._args: unknown[]) => eqResult),
      }
      // Make eqResult thenable so `await sb.from('X').update().eq().eq()` resolves.
      const eqThenable = Object.assign(eqResult, {
        then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
      })
      return { eq: vi.fn(() => eqThenable) }
    })

    // INSERT — supports both .insert(p).select().single() and bare .insert(p) (thenable)
    const insert = vi.fn((payload: unknown) => {
      insertCalls.push({ table, payload })
      const single = vi.fn().mockResolvedValue({ data: cfg.insertResult ?? { id: 'new-id' }, error: null })
      const selectAfterInsert = vi.fn(() => ({ single }))
      return Object.assign(
        { select: selectAfterInsert },
        // Bare insert: `await sb.from('X').insert(p)` resolves to { error: null }.
        { then: (resolve: (v: { error: null }) => void) => resolve({ error: null }) },
      )
    })

    return { select, update, insert }
  })

  return {
    from,
    rpc,
    insertCalls,
    updateCalls,
    supabase: { from, rpc } as unknown,
  }
}

export function buildToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const { supabase } = buildMockSupabase()
  return {
    clinicId: 'clinic-A',
    conversationId: 'conv-1',
    supabase: supabase as never,
    ...overrides,
  }
}
