/**
 * AI-3.5a: empty state pra knowledge base sem documents.
 *
 * Pure JSX — testable visually. Upload action ficará em AI-3.5b; por ora
 * orienta admin a usar `pnpm tsx packages/db/scripts/seed-kb.ts` (script
 * de dev).
 */
export default function KbEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3">
      <div className="text-[40px] opacity-50" aria-hidden>
        📚
      </div>
      <h2 className="text-[18px] font-semibold tracking-tight text-[var(--luma-text-primary)]">
        Nenhum documento ainda
      </h2>
      <p className="text-[13px] text-[var(--luma-text-tertiary)] max-w-md text-center">
        Quando documentos forem indexados, aparecerão aqui. A IA usa esse conteúdo pra responder
        perguntas dos pacientes sobre a clínica.
      </p>
    </div>
  );
}
