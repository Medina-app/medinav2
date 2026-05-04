export default function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-12 gap-1">
      <p className="text-[13px] text-[var(--luma-text-secondary)]">
        Selecione uma conversa pra ver o histórico.
      </p>
      <p className="text-[12px] text-[var(--luma-text-tertiary)]">
        As mensagens recebidas via WhatsApp aparecem na lista ao lado.
      </p>
    </div>
  );
}
