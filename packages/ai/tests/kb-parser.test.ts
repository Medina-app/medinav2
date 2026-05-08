import { describe, it, expect, vi } from 'vitest';
import { parseDocument, KB_SUPPORTED_FORMATS } from '../src/kb-parser.js';

describe('parseDocument', () => {
  it('detecta MD via hint "md" e retorna texto normalizado UTF-8', async () => {
    const buf = Buffer.from('# Title\r\n\r\nFirst paragraph.\r\n\r\n\r\n\r\nSecond.', 'utf-8');
    const result = await parseDocument({ body: buf, hint: 'md' });
    expect(result.text).toContain('# Title');
    expect(result.text).toContain('First paragraph.');
    expect(result.text).toContain('Second.');
    // CRLF normalizado pra LF
    expect(result.text).not.toContain('\r');
    // 4+ blank lines colapsados pra 1 \n\n
    expect(result.text.match(/\n{3,}/)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('detecta MD via mime type "text/markdown"', async () => {
    const buf = Buffer.from('# hello', 'utf-8');
    const result = await parseDocument({ body: buf, hint: 'text/markdown' });
    expect(result.text).toBe('# hello');
  });

  it('detecta TXT via hint "txt" e mime "text/plain"', async () => {
    const buf = Buffer.from('plain text content', 'utf-8');
    const result1 = await parseDocument({ body: buf, hint: 'txt' });
    const result2 = await parseDocument({ body: buf, hint: 'text/plain' });
    expect(result1.text).toBe('plain text content');
    expect(result2.text).toBe('plain text content');
  });

  it('aceita ArrayBuffer (não só Buffer) — server actions passam ArrayBuffer', async () => {
    const ab = new TextEncoder().encode('# from arraybuffer').buffer;
    const result = await parseDocument({ body: ab, hint: 'md' });
    expect(result.text).toBe('# from arraybuffer');
  });

  it('rejeita formato desconhecido com mensagem clara', async () => {
    const buf = Buffer.from('whatever', 'utf-8');
    await expect(parseDocument({ body: buf, hint: 'xlsx' })).rejects.toThrow(
      /unsupported format/i,
    );
  });

  it('rejeita PDF scanned (sem texto extraível) com mensagem actionable', async () => {
    // Mock pdf-parse pra retornar texto curto (< 50 chars) simulando scan
    vi.resetModules();
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({ text: 'a', numpages: 1 }),
    }));
    const { parseDocument: pd } = await import('../src/kb-parser.js');
    const buf = Buffer.from('fake-pdf-bytes', 'utf-8');
    await expect(pd({ body: buf, hint: 'pdf' })).rejects.toThrow(
      /scanned|sem texto extraível/i,
    );
    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });

  it('PDF: extrai texto quando pdf-parse retorna conteúdo válido', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({
        text:
          'Conteúdo do PDF com pelo menos 50 chars pra passar o threshold mínimo de detecção scanned.',
        numpages: 1,
      }),
    }));
    const { parseDocument: pd } = await import('../src/kb-parser.js');
    const buf = Buffer.from('fake-pdf-bytes', 'utf-8');
    const result = await pd({ body: buf, hint: 'pdf' });
    expect(result.text.length).toBeGreaterThan(50);
    expect(result.warnings).toEqual([]);
    vi.doUnmock('pdf-parse');
    vi.resetModules();
  });

  it('DOCX: extrai texto via mammoth e propaga warnings (não falha)', async () => {
    vi.resetModules();
    vi.doMock('mammoth', () => ({
      default: {
        extractRawText: vi.fn().mockResolvedValue({
          value: 'Conteúdo extraído do DOCX',
          messages: [{ type: 'warning', message: 'Image ignored' }],
        }),
      },
    }));
    const { parseDocument: pd } = await import('../src/kb-parser.js');
    const buf = Buffer.from('fake-docx-bytes', 'utf-8');
    const result = await pd({ body: buf, hint: 'docx' });
    expect(result.text).toBe('Conteúdo extraído do DOCX');
    expect(result.warnings).toContain('warning: Image ignored');
    vi.doUnmock('mammoth');
    vi.resetModules();
  });

  it('KB_SUPPORTED_FORMATS exporta lista canônica de 4 formatos (MD/TXT/PDF/DOCX)', () => {
    const exts = KB_SUPPORTED_FORMATS.map((f) => f.ext);
    expect(exts).toEqual(['md', 'txt', 'pdf', 'docx']);
  });
});
