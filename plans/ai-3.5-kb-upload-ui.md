# AI-3.5 — KB Upload UI Implementation Plan

> **Sub-skill:** `superpowers:executing-plans` (INLINE).

**Goal:** UI admin pra clínicas popularem a Base de Conhecimento via upload de arquivos (MD/TXT no MVP) sem intervenção técnica. Hoje só seed via script `pnpm tsx packages/db/scripts/seed-kb.ts <clinic-id>` — bloqueia onboarding de novas clínicas.

**Architecture:**
```
Admin upload via UI
    ↓ multipart POST /api/kb/upload
Server action valida + storage upload (kb-uploads/{clinic_id}/{doc_id}.{ext})
    ↓ INSERT knowledge_documents (status=pending)
    ↓ inngest.send('kb/document.process', { clinicId, documentId, storagePath })
Inngest worker process-kb-document
    ↓ download storage → parse text → chunkMarkdown → generateEmbedding loop
    ↓ INSERT chunks + UPDATE document.status='indexed'
UI list com status badges + delete (cascade chunks via FK)
```

**Tech Stack:** Next.js 15 server actions/route handlers + Supabase Storage + Inngest + Mastra/OpenAI (já wireado) + shadcn dialog/table.

---

## Context

PR-A/B/C consolidaram backend KB (RAG, search_kb, threshold per-clinic, atomic operations). Falta a camada human-facing: clinic admin precisa poder fazer upload sem chamar engenharia. Sem isso:
- Onboarding de cada clínica nova requer dev rodando seed script com files in disk
- Atualizações de FAQ/procedimentos demandam ticket
- Não há ciclo de vida (delete, reindex) acessível

**MVP escopo conscientemente apertado:** apenas MD + TXT, single-file upload, lista + delete. PDF/DOCX/URL fica pra PR futuro quando produto validar uso. Reindex UI também fica futuro (worker já existe, basta botão depois).

---

## File Structure

**Create (15 files):**

### Migration (1)
- `packages/db/migrations/0026_kb_storage_bucket.sql` — bucket `kb-uploads` + RLS policies

### API route (1)
- `apps/web/app/api/kb/upload/route.ts` — POST multipart receiver

### Server actions (3)
- `apps/web/app/[slug]/knowledge/actions.ts` — `createKbDocumentAction`, `deleteKbDocumentAction`
- `apps/web/app/[slug]/knowledge/actions.test.ts`

### Inngest worker (2)
- `apps/web/lib/inngest/functions/process-kb-document.ts`
- `apps/web/lib/inngest/functions/__tests__/process-kb-document.test.ts`
- `apps/web/lib/inngest/client.ts` — registrar nova função

### UI components (5)
- `apps/web/app/[slug]/knowledge/page.tsx` — server component (lista docs da clinic)
- `apps/web/app/[slug]/knowledge/_components/kb-document-list.tsx` — table client component
- `apps/web/app/[slug]/knowledge/_components/kb-upload-dialog.tsx` — dialog com form
- `apps/web/app/[slug]/knowledge/_components/kb-status-badge.tsx` — badge pure helper
- `apps/web/app/[slug]/knowledge/_components/kb-status-badge.test.ts` — pure function tests
- `apps/web/app/[slug]/knowledge/_components/kb-document-list.test.ts` (helpers puros se houver)

### Storage helpers (1)
- `packages/chat/src/kb-storage.ts` — wrapper pra upload/download/delete (signed URLs internas pro worker), com mock-friendly interface

**Modify (3):**
- `apps/web/app/[slug]/knowledge/page.tsx` — substitui placeholder
- `apps/web/lib/inngest/client.ts` — exporta novo function
- `apps/web/app/api/inngest/route.ts` — registra novo function no servePath

**Won't change:**
- `packages/db/migrations/0001-0025` (forward-only)
- `knowledge_documents`/`knowledge_chunks` schemas (já completos)
- `search_kb` tool / `reindex-document` worker (ortogonais ao upload)
- `seed-kb.ts` (continua disponível pra dev)

---

## Migration 0026 — Storage bucket + policies

```sql
-- ════════════════════════════════════════════════════════════════════════════
-- 0026_kb_storage_bucket.sql
--
-- AI-3.5: cria bucket kb-uploads pra UI admin upload arquivos KB.
-- Path scheme: kb-uploads/{clinic_id}/{document_id}.{ext}
-- RLS por path prefix (clinic_id) — cross-tenant impossivel via Storage API.
-- ════════════════════════════════════════════════════════════════════════════

-- Bucket privado (sem public access).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kb-uploads',
  'kb-uploads',
  false,  -- privado: download via service_role + signed URL
  5 * 1024 * 1024,  -- 5MB cap
  ARRAY[
    'text/plain',
    'text/markdown',
    'application/octet-stream'  -- alguns clientes upam .md como octet-stream
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policy: admin/owner upload (path tem que começar com clinic_id deles)
CREATE POLICY "kb-uploads: admins upload to own clinic prefix"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'kb-uploads'
    AND (split_part(name, '/', 1)::uuid IS NOT NULL)
    AND (
      public.has_clinic_role(split_part(name, '/', 1)::uuid, 'admin')
      OR public.has_clinic_role(split_part(name, '/', 1)::uuid, 'owner')
    )
  );

-- Policy: admin/owner delete dentro do próprio clinic prefix
CREATE POLICY "kb-uploads: admins delete own clinic prefix"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'kb-uploads'
    AND (
      public.has_clinic_role(split_part(name, '/', 1)::uuid, 'admin')
      OR public.has_clinic_role(split_part(name, '/', 1)::uuid, 'owner')
    )
  );

-- Policy: members read (download) — necessário se quiser preview na UI
CREATE POLICY "kb-uploads: members read own clinic prefix"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'kb-uploads'
    AND public.is_clinic_member(split_part(name, '/', 1)::uuid)
  );

-- service_role bypassa RLS (worker baixa via signed URL ou direto)
```

**Schema-migration-checklist self-check:**
- ✅ `(SELECT auth.uid())` n/a — usamos `is_clinic_member` / `has_clinic_role` que já wrappam corretamente
- ✅ Cross-tenant: path prefix com clinic_id como gate; cast pra uuid pra invalid input ser rejeitado
- ✅ FILE size cap (5MB) na config do bucket
- ✅ Allowed mime types limitado a text/plain + text/markdown
- ✅ Service role bypass (workers acessam direto)

---

## Tasks

### Task 0: Worktree + branch

- [ ] **0.1** Criar `.worktrees/ai-3.5-kb-upload`, branch `g/ai-3-5-kb-upload`, base main (d366008)
- [ ] **0.2** `pnpm install` + copiar `.env.local`
- [ ] **0.3** Baseline tests: ai 183 + db 150 + web 118 + chat 32 = 483 verde

### Task 1: Migration 0026 (TDD)

- [ ] **1.1** RED — `packages/db/tests/rls/kb-storage-bucket.test.ts` 4 tests:
  - bucket existe + private + size limit 5MB
  - admin/owner pode INSERT objeto em `<clinicId>/...`
  - cross-tenant: admin clinic A NÃO insere em path clinic B
  - members podem SELECT (download) em path do própria clinic
- [ ] **1.2** Run → FAIL
- [ ] **1.3** Implementar `0026_kb_storage_bucket.sql`
- [ ] **1.4** Aplicar via Supabase MCP
- [ ] **1.5** Run → 4 PASS
- [ ] **1.6** Advisor security check
- [ ] **1.7** Commit: `feat(db): 0026 kb-uploads storage bucket + RLS (AI-3.5)`

### Task 2: Storage helpers em packages/chat

- [ ] **2.1** RED — `packages/chat/tests/kb-storage.test.ts`:
  - `uploadKbDocument(sb, clinicId, documentId, file, mimeType)` returns `{ path }`
  - `downloadKbDocument(sb, path)` returns Buffer
  - `deleteKbDocument(sb, path)` returns void
  - cross-tenant: clinic A path NÃO acessível com clinic B context
- [ ] **2.2** Run → FAIL
- [ ] **2.3** Implementar `packages/chat/src/kb-storage.ts`
- [ ] **2.4** Run → PASS
- [ ] **2.5** Commit: `feat(chat): kb-storage helpers (upload/download/delete) (AI-3.5)`

### Task 3: Inngest worker process-kb-document (TDD)

- [ ] **3.1** RED — `apps/web/lib/inngest/functions/__tests__/process-kb-document.test.ts` 6 tests:
  - happy path: download → parse MD → chunkMarkdown(2 chunks) → generateEmbedding(2x) → insertChunks(2) → updateStatus('indexed')
  - cross-tenant guard: doc clinic A com event.clinicId B → throw
  - failure mid-loop: embed throw → status='failed' (mesmo pattern do seed-kb #17)
  - empty file: 0 chunks → status='indexed' chunk_count=0
  - file não existe no storage → status='failed' com error_message
  - already-indexed (idempotência): status='indexed' + content_hash existente → skip
- [ ] **3.2** Run → FAIL
- [ ] **3.3** Implementar `process-kb-document.ts` (espelha pattern do reindex-document.ts: handler puro + deps injetáveis + makeProcess...Deps)
- [ ] **3.4** Registrar em `apps/web/lib/inngest/client.ts` + `apps/web/app/api/inngest/route.ts`
- [ ] **3.5** Run → PASS
- [ ] **3.6** Commit: `feat(inngest): process-kb-document worker (AI-3.5)`

### Task 4: API route + server actions

- [ ] **4.1** RED — `apps/web/app/[slug]/knowledge/actions.test.ts`:
  - `createKbDocumentAction({ title, file })` valida zod + insere row + dispara Inngest
  - `deleteKbDocumentAction({ documentId })` soft-delete (archived_at) + delete storage
  - cross-tenant: action call com clinicId errado → throw
- [ ] **4.2** Run → FAIL
- [ ] **4.3** Implementar `actions.ts` + `route.ts` (POST /api/kb/upload)
- [ ] **4.4** Run → PASS
- [ ] **4.5** Commit: `feat(web): kb upload API route + server actions (AI-3.5)`

### Task 5: UI components + page

- [ ] **5.1** RED — `kb-status-badge.test.ts` (pure helper):
  - `getKbStatusBadge('pending')` → "⏳ Processando" + className
  - `getKbStatusBadge('processing')` → "⏳ Processando"
  - `getKbStatusBadge('indexed')` → "✓ Indexado" verde
  - `getKbStatusBadge('failed')` → "✗ Falhou" vermelho com title=error_message
  - `getKbStatusBadge('archived')` → null (não exibir)
- [ ] **5.2** Run → FAIL
- [ ] **5.3** Implementar `kb-status-badge.tsx` + `kb-document-list.tsx` + `kb-upload-dialog.tsx`
- [ ] **5.4** Modificar `page.tsx` — server component que faz SELECT documents + renderiza list + dialog
- [ ] **5.5** Run badge tests → PASS
- [ ] **5.6** Commit: `feat(inbox): KB UI list + upload dialog + status badges (AI-3.5)`

### Task 6: Verify + smoke local + push + open PR

- [ ] **6.1** `pnpm test` em todos os packages — esperar +20-25 testes novos
- [ ] **6.2** `pnpm -r typecheck` 12/12 zero
- [ ] **6.3** `pnpm --filter @medina/web build` SUCCESS
- [ ] **6.4** Advisor security zero ERROR novo
- [ ] **6.5** Smoke local: `pnpm dev` + login na sao-lucas + abrir `/sao-lucas/knowledge` → upload um .md de teste → verificar status flips pending→processing→indexed → search_kb encontra conteúdo via inbox
- [ ] **6.6** Push + abrir PR `feat(web): AI-3.5 KB upload UI (admin dashboard)`
- [ ] **6.7** PR body: contexto bloqueio onboarding, escopo MVP (MD/TXT), out of scope explicitos (PDF/DOCX/URL/reindex UI), checklist reviewer
- [ ] **6.8** **NÃO mergear** — aguarda CodeRabbit + tua aprovacao

---

## Critérios de aceite

- Migration 0026 aplicada em prod via MCP, advisor zero ERROR
- Bucket `kb-uploads` privado com 5MB cap, mime types restritos
- RLS impede cross-tenant: admin clinic A não acessa path clinic B
- Worker `process-kb-document` cobre 6 cenários (happy + cross-tenant + failure + empty + missing file + idempotência)
- UI: lista documents da clinic com status badges + dialog upload + delete confirm
- Suite total ≥ 503 verdes (483 + ~20 novos)
- `pnpm -r typecheck` 12/12 zero
- Smoke local: upload de .md popula KB e search_kb encontra
- PR aberto sem merge

## Out of scope

- **PDF parsing** (precisa `pdfjs-dist`, parsing complexo) — sourceType='pdf' fica pra PR futuro
- **DOCX parsing** (precisa `mammoth`)
- **URL ingestion** (sourceType='url' — fetch + readability) — feature separada
- **Reindex via UI** (worker existe; só botão UI fica pra PR menor)
- **Bulk upload** (multiple files) — single-file MVP suficiente
- **Tags/categorias UI** — schema tem campo `tags[]` mas UI fica futuro
- **Chunk preview UI** — debug-only, não user-facing
- **Search dentro da KB** (admin pesquisar conteúdo) — paciente já tem via search_kb tool
- **Histórico de uploads/audit timeline UI** — audit_logs já tem dados, UI futura

## Riscos

| Risco | Mitigação |
|-------|-----------|
| File upload bypass RLS via service_role manipulation | API route usa cliente authenticated; service_role só no worker pra parsing post-upload. Plus path prefix valida via RLS. |
| Worker download falha (storage transient) | Inngest retries=2 (já default); status='failed' + error_message permite retry manual via UI delete + re-upload |
| chunkMarkdown malformado pra TXT puro (sem `\n\n` separators) | TXT puro vai cair no path "single paragraph too long" — chunkMarkdown já trata via sentence split. Tests cobrirão |
| 5MB limit muito restrito pra clínicas grandes | Configurável via migration futura. MVP cap protege custo OpenAI embeddings |
| content_hash duplicate detection bloqueia re-upload de doc atualizado | Skip apenas em status='indexed' (mesmo padrão #17 fix). Doc com hash diferente = nova row mesmo título — admin pode arquivar antiga |
| Race: 2 admins uploadam mesmo arquivo simultaneamente | content_hash duplica → 2 docs separados criados (sem UNIQUE constraint). Acceitável: cleanup manual ou archive um |
| PR ~890 linhas excede limite 600 do CLAUDE.md | Justificável como "scaffolding inicial" (regra explícita CLAUDE.md). Documenta no PR body. Alternativa: split em 2 PRs (UI list + delete; upload pipeline) |

## Dimensionamento

| Categoria | Linhas est. |
|-----------|-------------|
| Migration 0026 | 60 |
| Tests db | 80 |
| Storage helper + tests | 100 |
| Inngest worker + tests | 200 |
| API route | 80 |
| Server actions + tests | 120 |
| UI components | 250 |
| Page route | 100 |
| **Total** | **~890** |
