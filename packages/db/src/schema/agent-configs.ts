import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

export type AgentStatus = 'draft' | 'published' | 'archived';

export const agentConfigs = pgTable(
  'agent_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(0),
    status: text('status').$type<AgentStatus>().notNull().default('draft'),
    systemPrompt: text('system_prompt').notNull(),
    model: text('model').notNull(),
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.7'),
    maxTokens: integer('max_tokens').notNull().default(1024),
    tools: jsonb('tools').notNull().default(sql`'[]'`),
    guardrails: jsonb('guardrails').notNull().default(sql`'{}'`),
    handoffRules: jsonb('handoff_rules').notNull().default(sql`'{}'`),
    knowledgeDocumentIds: uuid('knowledge_document_ids').array().notNull().default(sql`'{}'`),
    /** Issue #21: per-clinic similarity threshold pra search_kb tool. Default
     *  empirico 0.4 (text-embedding-3-small + PT-BR). CHECK [0, 1]. */
    kbSimilarityThreshold: numeric('kb_similarity_threshold', { precision: 3, scale: 2 })
      .notNull()
      .default('0.4'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'`),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_agent_configs_clinic_name_version')
      .on(t.clinicId, t.name, t.version)
      .where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('idx_agent_configs_clinic_name_published_unique')
      .on(t.clinicId, t.name)
      .where(sql`${t.status} = 'published' AND ${t.archivedAt} IS NULL`),
    index('idx_agent_configs_clinic_status_created').on(t.clinicId, t.status, t.createdAt),
    check('agent_configs_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check(
      'agent_configs_status_check',
      sql`${t.status} IN ('draft', 'published', 'archived')`,
    ),
    check(
      'agent_configs_temperature_check',
      sql`${t.temperature} >= 0 AND ${t.temperature} <= 2`,
    ),
    check('agent_configs_max_tokens_check', sql`${t.maxTokens} > 0`),
    check(
      'agent_configs_kb_similarity_threshold_valid',
      sql`${t.kbSimilarityThreshold} >= 0.0 AND ${t.kbSimilarityThreshold} <= 1.0`,
    ),
  ],
);

export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;
