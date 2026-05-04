# Post-CHAT-1 Backlog (não bloqueia CHAT-2)

## INFOs do code review (5 itens)

1. **iClinic typecheck pré-existente** — não relacionado CHAT-1, agendar fix em sprint posterior
2. **@medina/db cleanupAll global causa race em testes paralelos** — workaround atual: rodar com --concurrency=1. Fix: namespace cleanup por test file
3. **Admin client per-webhook (singleton)** — atualmente cria novo Supabase admin client em cada webhook hit. Refactor pra singleton (cache lazy)
4. **Defesa em profundidade no UPDATE phone_number_id** — atualmente o UPDATE não valida que clinic_id bate. Adicionar guard.
5. **Mapper Buffer cast em decrypt** — cast atual é forçado, deveria validar shape antes de cast

Cada um vira issue em GitHub Issues quando virar prioridade.
