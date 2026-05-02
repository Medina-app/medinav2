'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { inviteMemberAction, updateMemberRoleAction, removeMemberAction } from './actions'

type ClinicRole = 'owner' | 'admin' | 'member'

interface Member {
  id: string
  userId: string
  role: ClinicRole
  email: string
  name: string | undefined
  invitedAt: string | null
}

interface Props {
  members: Member[]
  currentUserId: string
  canManage: boolean
}

function MemberAvatar({ name, email }: { name: string | undefined; email: string }) {
  const initials = (name ?? email).slice(0, 2).toUpperCase()
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--luma-accent), #7c3aed)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        color: '#fff',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {initials}
    </div>
  )
}

const roleLabels: Record<ClinicRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Membro',
}

export function MembersClient({ members, currentUserId, canManage }: Props) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [invitePending, setInvitePending] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInvitePending(true)
    const r = await inviteMemberAction({ email: inviteEmail, role: inviteRole })
    setInvitePending(false)
    if (r.error) {
      toast.error(r.error)
    } else {
      toast.success('Convite enviado.')
      setInviteEmail('')
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    const r = await updateMemberRoleAction({ userId, newRole: newRole as ClinicRole })
    if (r.error) toast.error(r.error)
    else toast.success('Papel atualizado.')
  }

  async function handleRemove(userId: string) {
    setRemovingId(userId)
    const r = await removeMemberAction({ userId })
    setRemovingId(null)
    if (r.error) toast.error(r.error)
    else toast.success('Membro removido.')
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: 'var(--luma-text-primary)',
            margin: 0,
          }}
        >
          Membros
        </h1>
        <p style={{ fontSize: 13, color: 'var(--luma-text-tertiary)', marginTop: 4, marginBottom: 0 }}>
          Gerencie o time da clínica
        </p>
      </div>

      {canManage && (
        <form
          onSubmit={handleInvite}
          style={{
            background: 'var(--luma-bg-card)',
            border: '1px solid var(--luma-border)',
            borderRadius: 'var(--luma-radius-md)',
            padding: 20,
            display: 'flex',
            gap: 12,
            alignItems: 'flex-end',
          }}
        >
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Label
              htmlFor="invite-email"
              style={{ fontSize: 12, fontWeight: 500, color: 'var(--luma-text-secondary)' }}
            >
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="email@clinica.com"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              required
            />
          </div>
          <div style={{ width: 140, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Label
              htmlFor="invite-role"
              style={{ fontSize: 12, fontWeight: 500, color: 'var(--luma-text-secondary)' }}
            >
              Papel
            </Label>
            <Select value={inviteRole} onValueChange={v => { if (v) setInviteRole(v as 'admin' | 'member') }}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="member">Membro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={invitePending}>
            {invitePending ? 'Convidando...' : 'Convidar'}
          </Button>
        </form>
      )}

      <div
        style={{
          background: 'var(--luma-bg-card)',
          border: '1px solid var(--luma-border)',
          borderRadius: 'var(--luma-radius-md)',
          overflow: 'hidden',
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--luma-text-tertiary)',
                }}
              >
                Membro
              </TableHead>
              <TableHead
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--luma-text-tertiary)',
                }}
              >
                Papel
              </TableHead>
              <TableHead
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--luma-text-tertiary)',
                }}
              >
                Status
              </TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={canManage ? 4 : 3}
                  style={{
                    textAlign: 'center',
                    color: 'var(--luma-text-tertiary)',
                    fontSize: 13,
                    padding: '32px 16px',
                  }}
                >
                  Nenhum membro encontrado.
                </TableCell>
              </TableRow>
            ) : (
              members.map(m => (
                <TableRow
                  key={m.id}
                  style={{ borderBottom: '1px solid var(--luma-border)' }}
                >
                  <TableCell>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <MemberAvatar name={m.name} email={m.email} />
                      <div>
                        {m.name && (
                          <p
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: 'var(--luma-text-primary)',
                              margin: 0,
                              lineHeight: 1.3,
                            }}
                          >
                            {m.name}
                          </p>
                        )}
                        <p
                          style={{
                            fontSize: 12,
                            color: 'var(--luma-text-secondary)',
                            margin: 0,
                            lineHeight: 1.3,
                          }}
                        >
                          {m.email}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {canManage && m.userId !== currentUserId && m.role !== 'owner' ? (
                      <Select defaultValue={m.role} onValueChange={v => { if (v) handleRoleChange(m.userId, v) }}>
                        <SelectTrigger style={{ width: 120, height: 32, fontSize: 12 }}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="owner">Owner</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Membro</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        style={{
                          fontSize: 12,
                          color: 'var(--luma-text-secondary)',
                        }}
                      >
                        {roleLabels[m.role]}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      style={{
                        display: 'inline-block',
                        fontSize: 11,
                        fontWeight: 500,
                        padding: '2px 8px',
                        borderRadius: 99,
                        background: m.invitedAt
                          ? 'rgba(245,158,11,0.1)'
                          : 'rgba(16,185,129,0.1)',
                        color: m.invitedAt
                          ? 'var(--luma-warning)'
                          : 'var(--luma-success)',
                      }}
                    >
                      {m.invitedAt ? 'Pendente' : 'Ativo'}
                    </span>
                  </TableCell>
                  {canManage && (
                    <TableCell style={{ textAlign: 'right' }}>
                      {m.userId !== currentUserId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={removingId === m.userId}
                          onClick={() => handleRemove(m.userId)}
                          style={{
                            fontSize: 12,
                            color: 'var(--luma-danger)',
                            height: 28,
                          }}
                        >
                          {removingId === m.userId ? '...' : 'Remover'}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
