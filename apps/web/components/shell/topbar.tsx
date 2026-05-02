import { UserMenu } from './user-menu'

interface TopbarProps {
  email: string | undefined
}

export function Topbar({ email }: TopbarProps) {
  return (
    <div className="topbar">
      <UserMenu email={email} />
    </div>
  )
}
