import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

export type DocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'archived';
export type SourceType = 'pdf' | 'docx' | 'txt' | 'md' | 'url' | 'manual';

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    sourceType: text('source_type').$type<SourceType>().notNull(),
    sourceUrl: text('source_url'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    fileMimeType: text('file_mime_type'),
    contentHash: text('content_hash'),
    status: text('status').$type<DocumentStatus>().notNull().default('pending'),
    errorMessage: text('error_message'),
    chunkCount: integer('chunk_count').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    embeddingModel: text('embedding_model'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    metadata: jsonb('metadata').notNull().default(sql`'{}'`),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_knowledge_documents_clinic_status')
      .on(t.clinicId, t.status)
      .where(sql`${t.archivedAt} IS NULL`),
    index('idx_knowledge_documents_clinic_source_type')
      .on(t.clinicId, t.sourceType)
      .where(sql`${t.archivedAt} IS NULL`),
    index('idx_knowledge_documents_clinic_content_hash')
      .on(t.clinicId, t.contentHash)
      .where(sql`${t.contentHash} IS NOT NULL`),
    check('knowledge_documents_title_length', sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check(
      'knowledge_documents_source_type_check',
      sql`${t.sourceType} IN ('pdf','docx','txt','md','url','manual')`,
    ),
    check(
      'knowledge_documents_status_check',
      sql`${t.status} IN ('pending','processing','indexed','failed','archived')`,
    ),
  ],
);

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocument = typeof knowledgeDocuments.$inferInsert;
