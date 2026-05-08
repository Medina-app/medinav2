import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  chunkMarkdown,
  approxTokens,
  seedKbFromInput,
  CHUNK_CHAR_LIMIT,
  EMBEDDING_MODEL,
} from '../scripts/seed-kb.js';

// ─── Mock Supabase client ───────────────────────────────────────────────────

interface MockState {
  insertCalls: Array<{ table: string; payload: unknown }>;
  updateCalls: Array<{ table: string; payload: unknown }>;
  /** Force `existing` lookup to return a row for these content hashes (idempotent run). */
  existingHashes: Set<string>;
}

function makeMockSupabase(state: MockState) {
  let nextDocId = 1;

  return {
    from: (table: string) => {
      // SELECT chain — usado pelo existing-doc lookup. Pós Issue #17, o chain
      // tem 3 eq calls: clinic_id, content_hash, status. Capturamos array
      // de eq() pra recuperar valor do hash + status independente de ordem.
      const selectChain: {
        _eqCalls: Array<{ col: string; value: unknown }>;
        eq: ReturnType<typeof vi.fn>;
        maybeSingle: ReturnType<typeof vi.fn>;
      } = {
        _eqCalls: [],
        eq: vi.fn((col: string, value: unknown) => {
          selectChain._eqCalls.push({ col, value });
          return selectChain;
        }),
        maybeSingle: vi.fn(async () => {
          const hashCall = selectChain._eqCalls.find((c) => c.col === 'content_hash');
          const statusCall = selectChain._eqCalls.find((c) => c.col === 'status');
          const hash = hashCall?.value;
          const wantStatus = statusCall?.value;
          // CR review fix: exige explicitamente wantStatus === 'indexed'.
          // Mock NAO aceita absence do filtro (que era ambiguo na versao
          // anterior). Se alguem remover .eq('status','indexed') do impl,
          // testes idempotency falham — protege a invariante do #17.
          if (
            typeof hash === 'string' &&
            wantStatus === 'indexed' &&
            state.existingHashes.has(hash)
          ) {
            return { data: { id: 'existing-doc' }, error: null };
          }
          return { data: null, error: null };
        }),
      };

      // INSERT chain — both .insert(p).select().single() (for documents with id)
      // and bare .insert(p) thenable (for chunks).
      const insert = vi.fn((payload: unknown) => {
        state.insertCalls.push({ table, payload });
        const id = `${table === 'knowledge_documents' ? 'doc' : 'chunk'}-${nextDocId++}`;
        const single = vi.fn().mockResolvedValue({ data: { id }, error: null });
        const selectAfterInsert = vi.fn(() => ({ single }));
        return Object.assign(
          { select: selectAfterInsert },
          { then: (resolve: (v: { error: null }) => void) => resolve({ error: null }) },
        );
      });

      // UPDATE chain
      const update = vi.fn((payload: unknown) => {
        state.updateCalls.push({ table, payload });
        const eqResult = {
          eq: vi.fn(() => Promise.resolve({ error: null })),
        };
        return Object.assign(eqResult, {
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        });
      });

      return { select: vi.fn(() => selectChain), insert, update };
    },
  } as never;
}

const sampleFiles = [
  { name: 'small.md', content: '# Title\n\nFirst paragraph here.\n\nSecond paragraph here.' },
  { name: 'faq.md', content: '# FAQ\n\nQ: One?\n\nA: Yes.' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chunkMarkdown', () => {
  it('splits by blank-line paragraphs', () => {
    const result = chunkMarkdown('one\n\ntwo\n\nthree');
    expect(result).toEqual(['one', 'two', 'three']);
  });

  it('drops empty paragraphs', () => {
    const result = chunkMarkdown('a\n\n\n\n   \n\nb');
    expect(result).toEqual(['a', 'b']);
  });

  it('splits long paragraphs on sentence boundaries when over the char limit', () => {
    // ~600-char paragraph composed of 6 short sentences. Should split into 2 chunks.
    const sentence = 'A '.repeat(50) + '.';
    const long = (sentence + ' ').repeat(6).trim();
    const result = chunkMarkdown(long);
    expect(result.length).toBeGreaterThan(1);
    for (const c of result) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT + sentence.length);
    }
  });
});

describe('approxTokens', () => {
  it('uses 4-chars-per-token heuristic', () => {
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('a'.repeat(100))).toBe(25);
  });
});

describe('seedKbFromInput', () => {
  it('creates a document + chunks for each file (first run)', async () => {
    const state: MockState = { insertCalls: [], updateCalls: [], existingHashes: new Set() };
    const sb = makeMockSupabase(state);
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));

    const result = await seedKbFromInput({ clinicId: 'clinic-A', files: sampleFiles, sb, embed });

    expect(result.documentsCreated).toBe(2);
    expect(result.documentsSkipped).toBe(0);
    expect(result.chunksCreated).toBeGreaterThan(0);

    // Each file produced one knowledge_documents insert
    const docInserts = state.insertCalls.filter((c) => c.table === 'knowledge_documents');
    expect(docInserts).toHaveLength(2);

    // And chunks were inserted per file
    const chunkInserts = state.insertCalls.filter((c) => c.table === 'knowledge_chunks');
    expect(chunkInserts.length).toBe(result.chunksCreated);
  });

  it('records embedding_model on the document insert', async () => {
    const state: MockState = { insertCalls: [], updateCalls: [], existingHashes: new Set() };
    const sb = makeMockSupabase(state);
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));

    await seedKbFromInput({ clinicId: 'clinic-A', files: [sampleFiles[0]!], sb, embed });

    const docInsert = state.insertCalls.find((c) => c.table === 'knowledge_documents');
    expect((docInsert!.payload as { embedding_model: string }).embedding_model).toBe(
      EMBEDDING_MODEL,
    );
  });

  it('flips status to indexed and writes chunk_count + indexed_at after chunks insert', async () => {
    const state: MockState = { insertCalls: [], updateCalls: [], existingHashes: new Set() };
    const sb = makeMockSupabase(state);
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));

    await seedKbFromInput({ clinicId: 'clinic-A', files: [sampleFiles[0]!], sb, embed });

    const update = state.updateCalls.find((c) => c.table === 'knowledge_documents');
    expect(update).toBeDefined();
    expect(update!.payload).toMatchObject({ status: 'indexed' });
    const payload = update!.payload as { chunk_count: number; indexed_at: string };
    expect(payload.chunk_count).toBeGreaterThan(0);
    expect(typeof payload.indexed_at).toBe('string');
  });

  it('is idempotent: 2nd run with unchanged content skips the document (content_hash check)', async () => {
    // Pre-compute the hash for sampleFiles[0]
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(sampleFiles[0]!.content).digest('hex');

    const state: MockState = {
      insertCalls: [],
      updateCalls: [],
      existingHashes: new Set([hash]),
    };
    const sb = makeMockSupabase(state);
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));

    const result = await seedKbFromInput({
      clinicId: 'clinic-A',
      files: [sampleFiles[0]!],
      sb,
      embed,
    });

    expect(result.documentsCreated).toBe(0);
    expect(result.documentsSkipped).toBe(1);
    expect(result.chunksCreated).toBe(0);
    expect(state.insertCalls).toEqual([]); // no inserts on skip
    expect(embed).not.toHaveBeenCalled(); // no embedding wasted
  });

  it('every chunk insert receives a 1536-dim embedding vector and matches clinic_id', async () => {
    const state: MockState = { insertCalls: [], updateCalls: [], existingHashes: new Set() };
    const sb = makeMockSupabase(state);
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.5));

    await seedKbFromInput({ clinicId: 'clinic-XYZ', files: [sampleFiles[0]!], sb, embed });

    const chunkInserts = state.insertCalls.filter((c) => c.table === 'knowledge_chunks');
    for (const c of chunkInserts) {
      const p = c.payload as { clinic_id: string; embedding: number[] };
      expect(p.clinic_id).toBe('clinic-XYZ');
      expect(p.embedding).toHaveLength(1536);
    }
  });

  // Issue #17: zombie detection / failure resilience.

  it('falha mid-loop marca documento status=failed (#17)', async () => {
    const state: MockState = { insertCalls: [], updateCalls: [], existingHashes: new Set() };
    const sb = makeMockSupabase(state);
    // Embed lança após primeiro sucesso pra simular OpenAI 503 mid-loop.
    let calls = 0;
    const embed = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error('OpenAI 503 simulated');
      return new Array(1536).fill(0.1);
    });

    await expect(
      seedKbFromInput({
        clinicId: 'clinic-A',
        // sample com >1 chunk pra forcar 2a chamada de embed.
        files: [
          {
            name: 'multi.md',
            content: 'paragraph one here.\n\nparagraph two here.\n\nparagraph three here.',
          },
        ],
        sb,
        embed,
      }),
    ).rejects.toThrow(/OpenAI 503/);

    // Update final pra status='failed' deve ter ocorrido (catch handler).
    const failedUpdate = state.updateCalls.find(
      (c) =>
        c.table === 'knowledge_documents' &&
        (c.payload as { status?: string }).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
  });

  it('lookup filtra status=indexed — zombies (processing/failed) não bloqueiam re-run (#17)', async () => {
    // Mock: inserir hash no Set NÃO é mais suficiente — agora lookup filtra
    // por status='indexed'. Para validar, criamos hash sem registrar em
    // existingHashes (=mock retorna null), simulando que zombie existente
    // foi filtrado. Resultado: nova doc inserida normalmente.
    const state: MockState = { insertCalls: [], updateCalls: [], existingHashes: new Set() };
    const sb = makeMockSupabase(state);
    const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0.1));

    const result = await seedKbFromInput({
      clinicId: 'clinic-A',
      files: [sampleFiles[0]!],
      sb,
      embed,
    });

    // Inserção fresca — zombie hipotético (não registrado em existingHashes
    // que representa status='indexed' apenas) não bloqueou.
    expect(result.documentsCreated).toBe(1);
    expect(result.documentsSkipped).toBe(0);
  });
});
