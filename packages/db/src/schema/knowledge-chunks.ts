import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { knowledgeDocuments } from './knowledge-documents.js';

// pgvector vector(1536) — OpenAI text-embedding-3-small dimension
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
});

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector1536('embedding').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_knowledge_chunks_doc_chunk_unique').on(
      t.clinicId,
      t.documentId,
      t.chunkIndex,
    ),
    index('idx_knowledge_chunks_document_chunk').on(t.documentId, t.chunkIndex),
    // HNSW index is created in the migration directly (not expressible via Drizzle)
  ],
);

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof knowledgeChunks.$inferInsert;
