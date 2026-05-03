'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getTenantContext, getSupabaseServerClient, getSupabaseAdminClient, hasPermission } from '@medina/auth'

const InviteMemberSchema = z.object({
  email: z.string().email('O email informado é inválido'),
  role: z.enum(['admin', 'member']),
})

const UpdateRoleSchema = z.object({
  userId: z.string().uuid('ID de usuário inválido'),
  newRole: z.enum(['owner', 'admin', 'member']),
})

const RemoveMemberSchema = z.object({
  userId: z.string().uuid('ID de usuário inválido'),
})

type ActionResult = { error?: string; success?: boolean }

export async function inviteMemberAction(input: unknown): Promise<ActionResult> {
  const parsed = InviteMemberSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }

  const ctx = await getTenantContext()
  if (!hasPermission(ctx.role, 'member:manage')) return { error: 'Sem permissão para convidar membros.' }

  const adminClient = getSupabaseAdminClient()
  const { data: { users } } = await adminClient.auth.admin.listUsers()
  const target = users.find(u => u.email === parsed.data.email)

  if (!target) {
    return { error: 'Usuário ainda não tem conta no Medina. Peça pra ele criar conta primeiro.' }
  }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase.from('clinic_members').insert({
    clinic_id: ctx.clinicId,
    user_id: target.id,
    role: parsed.data.role,
    invited_by: ctx.user.id,
    invited_at: new Date().toISOString(),
  })

  if (error) {
    if (error.code === '23505') return { error: 'Esse usuário já é membro da clínica.' }
    return { error: error.message }
  }

  revalidatePath(`/${ctx.clinicSlug}/settings/members`, 'page')
  return { success: true }
}

export async function updateMemberRoleAction(input: unknown): Promise<ActionResult> {
  const parsed = UpdateRoleSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }

  const ctx = await getTenantContext()
  if (!hasPermission(ctx.role, 'member:manage')) return { error: 'Sem permissão para alterar papéis.' }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase
    .from('clinic_members')
    .update({ role: parsed.data.newRole })
    .eq('clinic_id', ctx.clinicId)
    .eq('user_id', parsed.data.userId)

  if (error) {
    if (error.message.includes('clinic must have at least one owner')) {
      return { error: 'A clínica precisa ter pelo menos um owner.' }
    }
    return { error: error.message }
  }

  revalidatePath(`/${ctx.clinicSlug}/settings/members`, 'page')
  return { success: true }
}

export async function removeMemberAction(input: unknown): Promise<ActionResult> {
  const parsed = RemoveMemberSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? 'Dados inválidos' }

  const ctx = await getTenantContext()
  if (!hasPermission(ctx.role, 'member:manage')) return { error: 'Sem permissão para remover membros.' }

  const supabase = await getSupabaseServerClient()
  const { error } = await supabase
    .from('clinic_members')
    .update({ deleted_at: new Date().toISOString() })
    .eq('clinic_id', ctx.clinicId)
    .eq('user_id', parsed.data.userId)

  if (error) {
    if (error.message.includes('clinic must have at least one owner')) {
      return { error: 'Não é possível remover o último owner.' }
    }
    return { error: error.message }
  }

  revalidatePath(`/${ctx.clinicSlug}/settings/members`, 'page')
  return { success: true }
}
