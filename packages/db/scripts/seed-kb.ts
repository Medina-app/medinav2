/**
 * Seeds knowledge base for a clinic. Idempotent via SHA-256 of file content
 * (knowledge_documents.content_hash) — re-running the script for a clinic
 * already seeded is a no-op for unchanged files.
 *
 * Markdown files in packages/db/scripts/kb-samples are split into ~500-char
 * paragraph chunks; each chunk gets a 1536-d OpenAI embedding (model
 * text-embedding-3-small). Inserts go through the service-role client so RLS
 * doesn't block them.
 *
 * CLI:
 *   pnpm tsx packages/db/scripts/seed-kb.ts <clinic-id>
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const CHUNK_CHAR_LIMIT = 500;

export interface SeedSummary {
  documentsCreated: number;
  documentsSkipped: number;
  chunksCreated: number;
}

export interface SeedKbInput {
  clinicId: string;
  files: Array<{ name: string; content: string }>;
  sb: SupabaseClient;
  embed: (text: string) => Promise<number[]>;
}

/**
 * Splits markdown by blank-line paragraphs. Paragraphs longer than CHUNK_CHAR_LIMIT
 * are split on sentence boundaries. A paragraph that's still longer than the limit
 * (rare — single very long sentence) is kept as a single chunk to avoid mid-sentence
 * cuts that break embedding quality.
 */
export function chunkMarkdown(content: string): string[] {
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_CHAR_LIMIT) {
      chunks.push(p);
      continue;
    }
    const sentences = p.match(/[^.!?]+[.!?]+/g) ?? [p];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > CHUNK_CHAR_LIMIT && buf.length > 0) {
        chunks.push(buf.trim());
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf.trim().length > 0) chunks.push(buf.trim());
  }
  return chunks;
}

/** Approximate token count via a 4-chars-per-token heuristic. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Pure seed function: takes input + deps, returns summary. Side effects only
 *  through the injected `sb` and `embed`. Easily mockable. */
export async function seedKbFromInput(input: SeedKbInput): Promise<SeedSummary> {
  const { clinicId, files, sb, embed } = input;
  const summary: SeedSummary = { documentsCreated: 0, documentsSkipped: 0, chunksCreated: 0 };

  for (const file of files) {
    const hash = createHash('sha256').update(file.content).digest('hex');

    const { data: existing, error: lookupErr } = await sb
      .from('knowledge_documents')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('content_hash', hash)
      .maybeSingle();
    if (lookupErr) throw new Error(`seed-kb: existing lookup failed: ${lookupErr.message}`);
    if (existing) {
      summary.documentsSkipped++;
      continue;
    }

    const title = basename(file.name, '.md');
    const { data: doc, error: insertErr } = await sb
      .from('knowledge_documents')
      .insert({
        clinic_id: clinicId,
        title,
        source_type: 'md',
        file_size_bytes: file.content.length,
        content_hash: hash,
        status: 'processing',
        embedding_model: EMBEDDING_MODEL,
      })
      .select('id')
      .single();
    if (insertErr || !doc) {
      throw new Error(`seed-kb: document insert failed for ${file.name}: ${insertErr?.message ?? 'no row'}`);
    }
    const documentId = (doc as { id: string }).id;

    const chunks = chunkMarkdown(file.content);
    let totalTokens = 0;
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i] ?? '';
      const embedding = await embed(text);
      const tokens = approxTokens(text);
      totalTokens += tokens;
      const { error: chunkErr } = await sb.from('knowledge_chunks').insert({
        clinic_id: clinicId,
        document_id: documentId,
        chunk_index: i,
        content: text,
        token_count: tokens,
        embedding,
        metadata: {},
      });
      if (chunkErr) {
        throw new Error(`seed-kb: chunk ${i} insert failed for ${file.name}: ${chunkErr.message}`);
      }
      summary.chunksCreated++;
    }

    const { error: updateErr } = await sb
      .from('knowledge_documents')
      .update({
        status: 'indexed',
        chunk_count: chunks.length,
        total_tokens: totalTokens,
        indexed_at: new Date().toISOString(),
      })
      .eq('id', documentId);
    if (updateErr) {
      throw new Error(`seed-kb: status update failed for ${file.name}: ${updateErr.message}`);
    }

    summary.documentsCreated++;
    console.log(`[seed-kb] ${title}: ${chunks.length} chunks, ~${totalTokens} tokens`);
  }
  return summary;
}

// ─── CLI wrapper ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, 'kb-samples');

export async function readSampleFiles(): Promise<Array<{ name: string; content: string }>> {
  const entries = (await readdir(SAMPLES_DIR)).filter((f) => f.endsWith('.md')).sort();
  const out: Array<{ name: string; content: string }> = [];
  for (const f of entries) {
    const content = await readFile(join(SAMPLES_DIR, f), 'utf-8');
    out.push({ name: f, content });
  }
  return out;
}

export function makeOpenAiEmbed(): (text: string) => Promise<number[]> {
  let client: OpenAI | null = null;
  return async (text: string) => {
    if (!client) {
      client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });
    }
    const response = await client.embeddings.create({ model: EMBEDDING_MODEL, input: text });
    const first = response.data[0];
    if (!first) throw new Error('OpenAI embeddings returned empty data array');
    return first.embedding;
  };
}

const invokedAs = process.argv[1] ?? '';
const isMain = invokedAs.endsWith('seed-kb.ts') || invokedAs.endsWith('seed-kb.js');
if (isMain) {
  const clinicId = process.argv[2];
  if (!clinicId) {
    console.error('Usage: pnpm tsx packages/db/scripts/seed-kb.ts <clinic-id>');
    process.exit(1);
  }
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    process.exit(1);
  }

  (async () => {
    const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const files = await readSampleFiles();
    const result = await seedKbFromInput({ clinicId, files, sb, embed: makeOpenAiEmbed() });
    console.log(JSON.stringify(result));
    process.exit(0);
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
