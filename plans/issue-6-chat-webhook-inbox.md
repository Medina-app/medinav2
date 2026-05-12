# Issue 6 — Chat Webhook + Inbox UI (CHAT-1)

> **Retrospective plan stub.** Implementation plan original consolidado em [`chat-1-webhook-and-inbox.md`](./chat-1-webhook-and-inbox.md). Este arquivo existe pra preencher a numeração `issue-N` no diretório `plans/` (B4 da auditoria post-push backlog: "missing plan files for issues 5, 6, 8, 9").

**Goal:** Receber webhooks de WhatsApp via Kapso, parsear inbound messages, criar/atualizar conversations + messages no BD, e expor a inbox UI pra atendentes verem mensagens em tempo real.

**Architecture:** Plan canônico mora em `plans/chat-1-webhook-and-inbox.md` (CHAT-1 era o codename interno antes da convenção `issue-N` consolidar). Não duplicar conteúdo — single source of truth lá.

**Tech Stack:** Next.js 15 webhook route handlers · `@medina/integrations-core` registry/dispatch · Supabase Postgres + RLS · Inngest p/ async outbound · `@medina/chat` (helpers lookupOrCreatePatientByPhone, getOrCreateConversation, addMessage) · Centrifugo realtime (CHAT-3 follow-up).

**Implementation commits:**
- `b5fb5f5` feat(chat): CHAT-1 webhook receiver kapso + inbox UI (#2)
- `8d51bc0` feat(chat): CHAT-3 centrifugo realtime no inbox (#4)

**Status:** Closed. Plan original em `chat-1-webhook-and-inbox.md` é a referência viva.
