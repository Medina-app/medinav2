-- ════════════════════════════════════════════════════════════════════════════
-- 0026_kb_storage_bucket.sql
--
-- AI-3.5b: cria bucket kb-uploads pra UI admin upload arquivos KB.
-- Path scheme: kb-uploads/{clinic_id}/{document_id}.{ext}
-- RLS por path prefix (clinic_id) — cross-tenant impossível via Storage API.
-- ════════════════════════════════════════════════════════════════════════════

-- Bucket privado, 5MB cap, mime types restritos.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kb-uploads',
  'kb-uploads',
  false,
  5 * 1024 * 1024,  -- 5MB
  ARRAY[
    'text/plain',
    'text/markdown',
    'application/octet-stream'  -- alguns clientes upam .md como octet-stream
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies em storage.objects pra bucket kb-uploads.
-- Path scheme: split_part(name, '/', 1) é o clinic_id como string; cast pra
-- uuid valida formato (input malicioso falha o cast → policy nega).

DROP POLICY IF EXISTS "kb-uploads: admins upload to own clinic prefix" ON storage.objects;
CREATE POLICY "kb-uploads: admins upload to own clinic prefix"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'kb-uploads'
    AND split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (
      public.has_clinic_role(split_part(name, '/', 1)::uuid, 'admin')
      OR public.has_clinic_role(split_part(name, '/', 1)::uuid, 'owner')
    )
  );

DROP POLICY IF EXISTS "kb-uploads: admins delete own clinic prefix" ON storage.objects;
CREATE POLICY "kb-uploads: admins delete own clinic prefix"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'kb-uploads'
    AND split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (
      public.has_clinic_role(split_part(name, '/', 1)::uuid, 'admin')
      OR public.has_clinic_role(split_part(name, '/', 1)::uuid, 'owner')
    )
  );

DROP POLICY IF EXISTS "kb-uploads: members read own clinic prefix" ON storage.objects;
CREATE POLICY "kb-uploads: members read own clinic prefix"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'kb-uploads'
    AND split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.is_clinic_member(split_part(name, '/', 1)::uuid)
  );
