-- ════════════════════════════════════════════════════════════════════════════
-- 0028_kb_bucket_allowlist_pdf_docx.sql
--
-- AI-3.5b CR fix #1 (CRITICAL): allowlist do bucket kb-uploads não incluía
-- application/pdf nem o MIME do DOCX. Server action createKbDocumentAction
-- aceita esses formatos e mapeia MIME via MIME_BY_EXT, mas o bucket
-- bloqueava no INSERT em storage.objects. Resultado: UX confirma upload
-- mas storage falha; rollback do row recém-inserido executa, e usuário vê
-- "Falha ao fazer upload" com a mensagem do Storage API.
--
-- Forward-only: usa UPDATE direto em vez de re-INSERT-ON-CONFLICT pra
-- preservar 'public' = false e qualquer outra config preservada por 0026.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'text/plain',
  'text/markdown',
  'application/octet-stream',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]::text[]
WHERE id = 'kb-uploads';
