import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { listConversations, getConversationWithMessages } from '@medina/chat';
import { loadPatientFacts, parseAiMemoryConfig, type FactCategory, type PatientFact } from '@medina/ai';
import ConversationList from './conversation-list';
import ConversationDetail from './conversation-detail';
import EmptyState from './empty-state';
import InboxRealtimeWrapper from './_components/inbox-realtime-wrapper';
import { PatientFactsPanel } from './_components/PatientFactsPanel';

interface InboxPageProps {
  searchParams: Promise<{ conversation?: string }>;
}

export default async function InboxPage({ searchParams }: InboxPageProps) {
  const { conversation: convId } = await searchParams;
  const [ctx, sb] = await Promise.all([getTenantContext(), getSupabaseServerClient()]);
  const items = await listConversations(sb, ctx.clinicId, { includeResolved: false });
  const detail = convId ? await getConversationWithMessages(sb, ctx.clinicId, convId) : null;

  // AI-6: load patient facts + memory config (best-effort; falha não bloqueia inbox).
  let memoryEnabled = false;
  let factsForPatient: PatientFact[] = [];
  try {
    const { data: clinic } = await sb
      .from('clinics')
      .select('metadata')
      .eq('id', ctx.clinicId)
      .single();
    const memoryConfig = parseAiMemoryConfig(
      (clinic?.metadata as { ai_memory?: unknown } | undefined)?.ai_memory,
    );
    memoryEnabled = memoryConfig.enabled && memoryConfig.categories.length > 0;
    if (memoryEnabled && detail?.patient?.id) {
      const enabledSet = new Set<FactCategory>(memoryConfig.categories);
      const all = await loadPatientFacts(sb, ctx.clinicId, detail.patient.id);
      factsForPatient = all.filter((f) => enabledSet.has(f.category));
    }
  } catch {
    // Silenciado — memory é opcional, inbox renderiza igual.
  }

  const canForget = ctx.role === 'owner' || ctx.role === 'admin';

  return (
    <div className="grid grid-cols-1 md:grid-cols-[360px_1fr] xl:grid-cols-[360px_1fr_320px] h-[calc(100vh-56px)] -m-6 md:-m-8">
      <div
        className={`${convId ? 'hidden md:block' : 'block'} border-r border-[var(--luma-border)] overflow-y-auto bg-[var(--luma-bg-card)]`}
      >
        <InboxRealtimeWrapper clinicId={ctx.clinicId} clinicSlug={ctx.clinicSlug}>
          <ConversationList
            items={items}
            selectedId={convId ?? null}
            clinicSlug={ctx.clinicSlug}
          />
        </InboxRealtimeWrapper>
      </div>
      <div className={`${convId ? 'block' : 'hidden md:block'} overflow-hidden`}>
        {detail ? (
          <ConversationDetail
            conversation={detail}
            clinicSlug={ctx.clinicSlug}
            clinicId={ctx.clinicId}
          />
        ) : (
          <EmptyState />
        )}
      </div>
      <div className="hidden xl:block">
        <PatientFactsPanel
          facts={factsForPatient}
          patientId={detail?.patient?.id ?? null}
          memoryEnabled={memoryEnabled}
          canForget={canForget}
          clinicSlug={ctx.clinicSlug}
        />
      </div>
    </div>
  );
}
