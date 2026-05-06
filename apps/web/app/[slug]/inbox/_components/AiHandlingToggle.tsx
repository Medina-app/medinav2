'use client';

import { useTransition, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { toggleAiHandlingAction } from '../toggle-ai-handling-action';

interface Props {
  conversationId: string;
  /** Current conversation.state. Toggle only renders for ai_handling/waiting_human. */
  state: string;
}

/**
 * Header pill for the conversation detail. Switches state between
 * ai_handling ↔ waiting_human via transition_conversation_state RPC.
 *
 * Hidden for terminal states (resolved) and template/assigned/paused —
 * those flows have their own controls (CHAT-4+ when templates land).
 *
 * Visual: teal accent (--luma-accent) when AI is on, neutral text when
 * paused. The Switch's thumb animation gives the click affordance; the
 * label changes synchronously with the optimistic toggle.
 */
export function AiHandlingToggle({ conversationId, state }: Props) {
  const [pending, startTransition] = useTransition();
  const [optimisticIsAi, setOptimisticIsAi] = useState(state === 'ai_handling');
  const [error, setError] = useState<string | null>(null);

  const showToggle = state === 'ai_handling' || state === 'waiting_human';
  if (!showToggle) return null;

  return (
    <div className="flex items-center gap-2 text-sm" data-slot="ai-handling-toggle">
      <span
        className={
          optimisticIsAi
            ? 'text-[var(--luma-accent)] font-medium'
            : 'text-[var(--luma-text-secondary)]'
        }
      >
        {optimisticIsAi ? 'IA atendendo' : 'Atendendo manualmente'}
      </span>
      <Switch
        checked={optimisticIsAi}
        disabled={pending}
        aria-label={
          optimisticIsAi ? 'Pausar IA nesta conversa' : 'Retomar IA nesta conversa'
        }
        onCheckedChange={(checked) => {
          const next = checked ? 'ai_handling' : 'waiting_human';
          setOptimisticIsAi(checked);
          setError(null);
          startTransition(async () => {
            const r = await toggleAiHandlingAction({ conversationId, newState: next });
            if ('error' in r) {
              // Rollback optimistic update on failure.
              setOptimisticIsAi(!checked);
              setError(r.error);
            }
          });
        }}
      />
      {error ? (
        <span className="text-xs text-[var(--luma-danger)]" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
