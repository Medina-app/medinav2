import { getTenantContext, getSupabaseServerClient, getSupabaseAdminClient, hasPermission } from '@medina/auth'
import { MembersClient } from './members-client'

export default async function MembersPage() {
  const ctx = await getTenantContext()
  const supabase = await getSupabaseServerClient()

  const { data: rawMembers } = await supabase
    .from('clinic_members')
    .select('id, user_id, role, invited_at')
    .eq('clinic_id', ctx.clinicId)
    .is('deleted_at', null)

  const adminClient = getSupabaseAdminClient()
  const { data: { users } } = await adminClient.auth.admin.listUsers()
  const userMap = new Map(
    users.map(u => [
      u.id,
      {
        email: u.email ?? '',
        name: (u.user_metadata as Record<string, unknown>)?.['full_name'] as string | undefined,
      },
    ])
  )

  const members = (rawMembers ?? []).map(m => ({
    id: m.id,
    userId: m.user_id as string,
    role: m.role as 'owner' | 'admin' | 'member',
    email: userMap.get(m.user_id)?.email ?? 'unknown',
    name: userMap.get(m.user_id)?.name,
    invitedAt: m.invited_at as string | null,
  }))

  const canManage = hasPermission(ctx.role, 'member:manage')

  return (
    <MembersClient
      members={members}
      currentUserId={ctx.user.id}
      canManage={canManage}
    />
  )
}
