'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export function isNavActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(href + '/')
}

interface NavItemProps {
  href: string
  exact?: boolean
  children: ReactNode
}

export function NavItem({ href, exact = false, children }: NavItemProps) {
  const pathname = usePathname()
  const active = isNavActive(pathname, href, exact)
  return (
    <Link href={href} className={`nav-item${active ? ' active' : ''}`}>
      {children}
    </Link>
  )
}
