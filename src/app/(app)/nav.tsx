'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

export type NavItem = { href: string; label: string }

const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'))

/** Navigasi samping (desktop). */
export function SideNav({ staff, owner }: { staff: NavItem[]; owner: NavItem[] | null }) {
  const path = usePathname()
  const item = (n: NavItem) => (
    <Link
      key={n.href}
      href={n.href}
      aria-current={isActive(path, n.href) ? 'page' : undefined}
      className="flex min-h-10 items-center rounded-lg px-2.5 text-sm font-medium hover:bg-navy-800 hover:text-white aria-[current=page]:bg-navy-700 aria-[current=page]:text-white"
    >
      {n.label}
    </Link>
  )
  return (
    <nav aria-label="Navigasi utama" className="flex flex-col gap-0.5">
      <span className="px-2.5 pb-1.5 pt-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8790a6]">Operasional</span>
      {staff.map(item)}
      {owner && (
        <>
          <span className="px-2.5 pb-1.5 pt-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8790a6]">Owner</span>
          {owner.map(item)}
        </>
      )}
    </nav>
  )
}

/** Header ringkas + menu lengkap yang bisa dibuka (HP). */
export function MobileMenu({ staff, owner, name, role }: { staff: NavItem[]; owner: NavItem[] | null; name: string; role: string }) {
  const path = usePathname()
  const ref = useRef<HTMLDetailsElement>(null)
  // Tutup menu setiap pindah halaman.
  useEffect(() => {
    if (ref.current) ref.current.open = false
  }, [path])
  const all = [...staff, ...(owner ?? [])]
  const current = all.filter((n) => isActive(path, n.href)).sort((a, b) => b.href.length - a.href.length)[0]
  return (
    <details ref={ref} className="group relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg bg-navy-800 px-3 text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
        <span className="max-w-36 truncate">{current?.label ?? 'Menu'}</span>
        <span aria-hidden className="text-xs transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute right-0 z-30 mt-2 flex max-h-[70vh] w-64 flex-col gap-0.5 overflow-y-auto rounded-xl bg-navy-900 p-2 shadow-xl ring-1 ring-navy-700">
        <span className="px-2.5 pb-1 pt-1.5 text-xs text-[#8790a6]">{name} · {role}</span>
        {[{ t: 'Operasional', l: staff }, ...(owner ? [{ t: 'Owner', l: owner }] : [])].map((g) => (
          <div key={g.t} className="flex flex-col gap-0.5">
            <span className="px-2.5 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8790a6]">{g.t}</span>
            {g.l.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(path, n.href) ? 'page' : undefined}
                className="flex min-h-11 items-center rounded-lg px-2.5 text-sm text-[#c5cbd9] aria-[current=page]:bg-navy-700 aria-[current=page]:text-white"
              >
                {n.label}
              </Link>
            ))}
          </div>
        ))}
        <form action="/api/auth/logout" method="post" className="mt-1 border-t border-navy-700 pt-1">
          <button className="flex min-h-11 w-full items-center rounded-lg px-2.5 text-sm font-semibold text-white">Keluar</button>
        </form>
      </div>
    </details>
  )
}

const TABS: NavItem[] = [
  { href: '/', label: 'Beranda' },
  { href: '/orders/new', label: 'Order' },
  { href: '/accounts', label: 'Akun' },
  { href: '/attendance', label: 'Absensi' },
  { href: '/stock', label: 'Stok' },
]

/** Bilah tab bawah untuk tugas harian staf di HP. */
export function BottomTabs() {
  const path = usePathname()
  return (
    <nav aria-label="Pintasan" className="fixed inset-x-0 bottom-0 z-20 flex border-t border-cream-300 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={isActive(path, t.href) ? 'page' : undefined}
          className="flex min-h-14 flex-1 items-center justify-center text-xs font-semibold text-ink-500 aria-[current=page]:text-navy-900 aria-[current=page]:shadow-[inset_0_3px_0_var(--color-orange-500)]"
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
