import { headers } from 'next/headers'
import { SettingsNav } from './settings-nav'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const slug = (await headers()).get('x-tenant-slug') ?? ''

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <SettingsNav slug={slug} />
      <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  )
}
