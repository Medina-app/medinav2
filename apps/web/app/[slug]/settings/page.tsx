import { redirect } from 'next/navigation'
import { headers } from 'next/headers'

export default async function SettingsPage() {
  const slug = (await headers()).get('x-tenant-slug') ?? ''
  redirect(`/${slug}/settings/general`)
}
