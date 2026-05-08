import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * AI-3.5b: helpers wrapping Supabase Storage pra bucket `kb-uploads`.
 *
 * Path scheme: `{clinicId}/{documentId}.{ext}` — RLS por path prefix
 * (migration 0026) garante que admin clinic-A não escreve em path
 * clinic-B. Service_role bypassa RLS — worker (Inngest) usa pra
 * download + delete cascade.
 *
 * Helpers são thin wrappers — caller passa o sb client com permissão
 * apropriada. Testes mockam sb.storage diretamente.
 */

const KB_BUCKET = 'kb-uploads';

export interface UploadKbDocumentArgs {
  sb: SupabaseClient;
  clinicId: string;
  documentId: string;
  /** File extension sem ponto (e.g., 'md', 'txt', 'pdf', 'docx'). */
  ext: string;
  /** Body bytes — Buffer no worker, ArrayBuffer/Blob no browser/server action. */
  body: ArrayBuffer | Blob | Buffer;
  mimeType: string;
}

export interface UploadKbDocumentResult {
  path: string;
}

export async function uploadKbDocument(
  args: UploadKbDocumentArgs,
): Promise<UploadKbDocumentResult> {
  const path = `${args.clinicId}/${args.documentId}.${args.ext}`;
  const { error } = await args.sb.storage.from(KB_BUCKET).upload(path, args.body, {
    contentType: args.mimeType,
    upsert: false, // recusa overwrite — força documentId único
  });
  if (error) {
    throw new Error(`uploadKbDocument: ${error.message}`);
  }
  return { path };
}

export interface DownloadKbDocumentArgs {
  sb: SupabaseClient;
  path: string;
}

export async function downloadKbDocument(
  args: DownloadKbDocumentArgs,
): Promise<Buffer> {
  const { data, error } = await args.sb.storage.from(KB_BUCKET).download(args.path);
  if (error || !data) {
    throw new Error(`downloadKbDocument: ${error?.message ?? 'no data'}`);
  }
  // Blob → ArrayBuffer → Buffer pra Node.js parsers (mammoth, pdf-parse).
  const arrayBuf = await data.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export interface DeleteKbDocumentArgs {
  sb: SupabaseClient;
  path: string;
}

export async function deleteKbDocument(args: DeleteKbDocumentArgs): Promise<void> {
  const { error } = await args.sb.storage.from(KB_BUCKET).remove([args.path]);
  if (error) {
    throw new Error(`deleteKbDocument: ${error.message}`);
  }
}

/** Constrói path canônico (clinicId/documentId.ext) sem fazer upload. Útil
 *  quando caller só precisa do path pra inserir em DB ou logs. */
export function kbDocumentPath(clinicId: string, documentId: string, ext: string): string {
  return `${clinicId}/${documentId}.${ext}`;
}

export const KB_UPLOADS_BUCKET = KB_BUCKET;
