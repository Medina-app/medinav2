/**
 * AI-3.5b: parser de documents pra Knowledge Base.
 *
 * Suporta MD, TXT, PDF, DOCX. Detecta via mime type ou extensão.
 *
 * - MD/TXT: leitura UTF-8 direta
 * - PDF: pdf-parse (rejeita scanned PDFs sem texto extraível)
 * - DOCX: mammoth (loga warnings mas não falha)
 *
 * Output: text content normalizado (whitespace, line endings unix), pronto
 * pra chunkMarkdown. Lança Error com mensagem actionable em failure.
 */

export interface ParseDocumentArgs {
  /** File bytes (Node.js Buffer ou ArrayBuffer). */
  body: Buffer | ArrayBuffer;
  /** Hint pra detecção: 'md' | 'txt' | 'pdf' | 'docx' OU mime type. */
  hint: string;
}

export interface ParseDocumentResult {
  /** Conteúdo de texto extraído, com whitespace normalizado. */
  text: string;
  /** Warnings não-fatais do parser (e.g., images ignoradas em DOCX). */
  warnings: string[];
}

/** Heurística simples — extensão tem precedência sobre mime se conflitar. */
function detectFormat(hint: string): 'md' | 'txt' | 'pdf' | 'docx' {
  const h = hint.toLowerCase();
  if (h.endsWith('md') || h === 'text/markdown') return 'md';
  if (h.endsWith('txt') || h === 'text/plain') return 'txt';
  if (h.endsWith('pdf') || h === 'application/pdf') return 'pdf';
  if (
    h.endsWith('docx') ||
    h === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  throw new Error(`parseDocument: unsupported format hint "${hint}"`);
}

function toBuffer(body: Buffer | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body);
}

function normalizeText(raw: string): string {
  // Normaliza line endings + remove zero-width chars + colapsa whitespace
  // excessivo, mas preserva blank lines (chunkMarkdown depende de \n\n).
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parseMd(body: Buffer): Promise<ParseDocumentResult> {
  const text = body.toString('utf-8');
  return { text: normalizeText(text), warnings: [] };
}

async function parseTxt(body: Buffer): Promise<ParseDocumentResult> {
  // Idêntico a MD em essência (UTF-8); separados pra documentation +
  // possíveis divergências futuras (e.g., TXT sem markdown structure).
  const text = body.toString('utf-8');
  return { text: normalizeText(text), warnings: [] };
}

async function parsePdf(body: Buffer): Promise<ParseDocumentResult> {
  // Dynamic import pra evitar carregar pdf-parse no startup (lib é pesada).
  const pdfParseMod = await import('pdf-parse');
  const pdfParse = (pdfParseMod.default ?? pdfParseMod) as (
    buf: Buffer,
  ) => Promise<{ text: string; numpages: number }>;
  const result = await pdfParse(body);
  const text = normalizeText(result.text);

  if (text.length < 50) {
    // Heurística pra rejeitar PDFs scanned (imagem, sem text layer).
    // Threshold 50 chars: PDFs reais tem 100s+ chars; scanned vira "" ou
    // poucos chars de OCR ruidoso.
    throw new Error(
      `parseDocument: PDF parece scanned ou sem texto extraível (${text.length} chars). Rejeite ou re-OCR antes de subir.`,
    );
  }
  return { text, warnings: [] };
}

async function parseDocx(body: Buffer): Promise<ParseDocumentResult> {
  const mammothMod = await import('mammoth');
  const mammoth = mammothMod.default ?? mammothMod;
  const result = await mammoth.extractRawText({ buffer: body });
  const text = normalizeText(result.value);
  const warnings = (result.messages ?? []).map(
    (m: { type?: string; message?: string }) => `${m.type ?? 'msg'}: ${m.message ?? ''}`,
  );
  return { text, warnings };
}

export async function parseDocument(args: ParseDocumentArgs): Promise<ParseDocumentResult> {
  const fmt = detectFormat(args.hint);
  const buf = toBuffer(args.body);
  switch (fmt) {
    case 'md':
      return parseMd(buf);
    case 'txt':
      return parseTxt(buf);
    case 'pdf':
      return parsePdf(buf);
    case 'docx':
      return parseDocx(buf);
  }
}

export const KB_SUPPORTED_FORMATS: ReadonlyArray<{ ext: string; mime: string }> = [
  { ext: 'md', mime: 'text/markdown' },
  { ext: 'txt', mime: 'text/plain' },
  { ext: 'pdf', mime: 'application/pdf' },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
];
