'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

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

const TABS: NavItem[] = [
  { href: '/', label: 'Beranda' },
  { href: '/orders/new', label: 'Order' },
  { href: '/accounts', label: 'Akun' },
  { href: '/attendance', label: 'Absensi' },
  { href: '/stock', label: 'Stok' },
]
// Modul yang punya navigasi internal sendiri di bagian bawah/atas: bilah tab global tidak ditampilkan agar tidak bertumpuk.
const NO_BOTTOM_TABS = ['/finance']

/**
 * Navigasi HP: header ringkas + menu lipat (dengan backdrop) + bilah tab bawah.
 * Satu state agar bilah tab bawah tersembunyi selama menu terbuka.
 */
export function MobileNav({ logo, staff, owner, name, role }: { logo: React.ReactNode; staff: NavItem[]; owner: NavItem[] | null; name: string; role: string }) {
  const path = usePathname()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  // Tutup saat pindah halaman.
  useEffect(() => setOpen(false), [path])
  // Escape menutup menu; gulir halaman dikunci selama menu terbuka.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const prev = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.documentElement.style.overflow = prev
    }
  }, [open])

  const all = [...staff, ...(owner ?? [])]
  const current = all.filter((n) => isActive(path, n.href)).sort((a, b) => b.href.length - a.href.length)[0]
  const showTabs = !open && !NO_BOTTOM_TABS.some((p) => isActive(path, p))

  return (
    <>
      <header className="sticky top-0 z-50 flex min-h-[3.75rem] items-center justify-between gap-3 bg-navy-900 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] md:hidden">
        <span className="min-w-0 shrink">{logo}</span>
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 max-w-[55%] shrink-0 items-center gap-2 rounded-lg bg-navy-800 px-3 text-sm font-semibold text-white"
        >
          <span className="truncate">{open ? 'Tutup menu' : (current?.label ?? 'Menu')}</span>
          <span aria-hidden className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </header>

      {open && (
        <>
          {/* Backdrop menutupi konten & bilah tab bawah; ketuk untuk menutup. */}
          <div className="fixed inset-0 z-40 bg-navy-900/50 md:hidden" aria-hidden onClick={() => setOpen(false)} />
          <nav
            id="mobile-menu"
            aria-label="Navigasi utama"
            className="fixed right-3 top-[calc(3.75rem+env(safe-area-inset-top)+0.5rem)] z-50 flex max-h-[calc(100dvh-3.75rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1.5rem)] w-[min(18rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl bg-navy-900 shadow-2xl ring-1 ring-navy-700 md:hidden"
          >
            <div className="shrink-0 border-b border-navy-700 px-4 py-3">
              <span className="block truncate text-sm font-semibold text-white">{name}</span>
              <span className="text-xs text-[#8790a6]">{role}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              {[{ t: 'Operasional', l: staff }, ...(owner ? [{ t: 'Owner', l: owner }] : [])].map((g) => (
                <div key={g.t} className="flex flex-col gap-0.5">
                  <span className="px-2.5 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8790a6]">{g.t}</span>
                  {g.l.map((n) => (
                    <Link
                      key={n.href}
                      href={n.href}
                      onClick={() => setOpen(false)}
                      aria-current={isActive(path, n.href) ? 'page' : undefined}
                      className="flex min-h-11 items-center rounded-lg px-2.5 text-sm text-[#c5cbd9] aria-[current=page]:bg-navy-700 aria-[current=page]:text-white"
                    >
                      {n.label}
                    </Link>
                  ))}
                </div>
              ))}
            </div>
            <form action="/api/auth/logout" method="post" className="shrink-0 border-t border-navy-700 p-2">
              <button className="flex min-h-11 w-full items-center rounded-lg px-2.5 text-sm font-semibold text-white">Keluar</button>
            </form>
          </nav>
        </>
      )}

      {showTabs && (
        <nav aria-label="Pintasan" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-cream-300 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
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
      )}
    </>
  )
}
