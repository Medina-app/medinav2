import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestKnowledgeDocument,
  deleteTestClinic,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinicIds: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinicIds.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

async function makeClinic(name: string): Promise<{ id: string }> {
  const c = await createTestClinic(sql, name);
  createdClinicIds.push(c.id);
  return c;
}

describe('AI-3.5b: knowledge_documents approval workflow', () => {
  it('1. coluna approval_status existe + default pending_approval em rows novas', async () => {
    const c = await makeClinic('Approval-Default');
    // INSERT direto SEM passar approval_status pra validar o DEFAULT do schema.
    // Helper createTestKnowledgeDocument seta approved por default — útil pra
    // outros testes mas inadequado pra validar default real da coluna.
    const [row] = await sql<{ id: string; approval_status: string }[]>`
      INSERT INTO knowledge_documents (clinic_id, title, source_type)
      VALUES (${c.id}, ${'Approval-Default-Doc'}, 'manual')
      RETURNING id, approval_status
    `;
    expect(row?.approval_status).toBe('pending_approval');
  });

  it('2. CHECK rejeita approval_status fora do enum', async () => {
    const c = await makeClinic('Approval-CheckBad');
    const doc = await createTestKnowledgeDocument(sql, c.id);

    await expect(sql`
      UPDATE knowledge_documents SET approval_status = 'invalid' WHERE id = ${doc.id}
    `).rejects.toThrow(/check constraint|approval_status_valid/i);
  });

  it('3. aceita transições approved + rejected + colunas auxiliares', async () => {
    const c = await makeClinic('Approval-Transitions');
    const doc = await createTestKnowledgeDocument(sql, c.id);

    await sql`
      UPDATE knowledge_documents
      SET approval_status = 'approved',
          approved_at = NOW(),
          rejection_reason = NULL
      WHERE id = ${doc.id}
    `;
    const [a] = await sql<{ approval_status: string; approved_at: string | null }[]>`
      SELECT approval_status, approved_at FROM knowledge_documents WHERE id = ${doc.id}
    `;
    expect(a?.approval_status).toBe('approved');
    expect(a?.approved_at).not.toBeNull();

    await sql`
      UPDATE knowledge_documents
      SET approval_status = 'rejected',
          rejection_reason = 'conteúdo desatualizado'
      WHERE id = ${doc.id}
    `;
    const [r] = await sql<{ approval_status: string; rejection_reason: string | null }[]>`
      SELECT approval_status, rejection_reason FROM knowledge_documents WHERE id = ${doc.id}
    `;
    expect(r?.approval_status).toBe('rejected');
    expect(r?.rejection_reason).toBe('conteúdo desatualizado');
  });

  it('4. backfill: rows criadas pre-migration têm approval_status preenchido (não NULL)', async () => {
    // Verify: zero docs em prod com approval_status IS NULL após backfill
    // (incluindo as 3 docs seedadas em sao-lucas).
    const [count] = await sql<{ null_count: string }[]>`
      SELECT COUNT(*)::text AS null_count
      FROM knowledge_documents
      WHERE approval_status IS NULL
    `;
    expect(parseInt(count?.null_count ?? '999', 10)).toBe(0);
  });

  it('5. search_knowledge_chunks_internal SOMENTE retorna chunks de docs approved (filtro RPC)', async () => {
    // Skip in test env if RPC behavior depends on specific embedding setup;
    // smoke validation: garante doc pending_approval NÃO aparece nos chunks.
    const c = await makeClinic('Approval-RPC-Filter');
    const docPending = await createTestKnowledgeDocument(sql, c.id, { title: 'Pending Doc' });
    const docApproved = await createTestKnowledgeDocument(sql, c.id, { title: 'Approved Doc' });

    // Mark docs como indexed + diferenciar approval_status.
    await sql`
      UPDATE knowledge_documents
      SET status = 'indexed',
          approval_status = 'approved',
          approved_at = NOW()
      WHERE id = ${docApproved.id}
    `;
    await sql`
      UPDATE knowledge_documents
      SET status = 'indexed',
          approval_status = 'pending_approval'
      WHERE id = ${docPending.id}
    `;

    // Insere chunk pra cada doc com embedding sintético.
    const fakeEmbedding = `[${Array(1536).fill(0.1).join(',')}]`;
    await sql`
      INSERT INTO knowledge_chunks (clinic_id, document_id, chunk_index, content, token_count, embedding)
      VALUES
        (${c.id}, ${docApproved.id}, 0, 'approved content', 5, ${fakeEmbedding}::vector),
        (${c.id}, ${docPending.id}, 0, 'pending content', 5, ${fakeEmbedding}::vector)
    `;

    // RPC busca: deve retornar SÓ approved doc.
    const rows = await sql<{ document_id: string }[]>`
      SELECT document_id FROM search_knowledge_chunks_internal(
        ${c.id}::uuid, ${fakeEmbedding}::vector, 10, NULL
      )
    `;
    const docIds = rows.map((r) => r.document_id);
    expect(docIds).toContain(docApproved.id);
    expect(docIds).not.toContain(docPending.id);
  });

  it('6. search_knowledge_chunks_internal exclui rejected documents', async () => {
    const c = await makeClinic('Approval-RPC-Reject');
    const docRejected = await createTestKnowledgeDocument(sql, c.id, { title: 'Rejected Doc' });

    await sql`
      UPDATE knowledge_documents
      SET status = 'indexed',
          approval_status = 'rejected',
          rejection_reason = 'test'
      WHERE id = ${docRejected.id}
    `;

    const fakeEmbedding = `[${Array(1536).fill(0.1).join(',')}]`;
    await sql`
      INSERT INTO knowledge_chunks (clinic_id, document_id, chunk_index, content, token_count, embedding)
      VALUES (${c.id}, ${docRejected.id}, 0, 'rejected content', 5, ${fakeEmbedding}::vector)
    `;

    const rows = await sql<{ document_id: string }[]>`
      SELECT document_id FROM search_knowledge_chunks_internal(
        ${c.id}::uuid, ${fakeEmbedding}::vector, 10, NULL
      )
    `;
    expect(rows.map((r) => r.document_id)).not.toContain(docRejected.id);
  });
});
