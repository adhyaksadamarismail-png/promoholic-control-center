'use client'

import Link, { useLinkStatus } from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Icon, type IconName } from '@/components/icons'
import { reducedMotion } from '@/components/motion'

export type NavItem = { href: string; label: string; icon: IconName; badge?: number }

const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'))

/** Tanda langsung pada menu yang diklik selama halaman tujuan dimuat (tanpa membungkus halaman dengan Suspense). */
function PendingDot() {
  const { pending } = useLinkStatus()
  return (
    <span aria-hidden={!pending} className={`size-2 shrink-0 animate-pulse rounded-full bg-orange-500 ${pending ? '' : 'invisible'}`}>
      <span className="sr-only">{pending ? 'Memuat…' : ''}</span>
    </span>
  )
}

function Badge({ n }: { n?: number }) {
  if (!n) return null
  return (
    <span className="rounded-full bg-orange-500 px-1.5 text-[11px] font-bold leading-5 text-navy-900">
      {n}
      <span className="sr-only"> menunggu</span>
    </span>
  )
}

const COLLAPSE_KEY = 'ph-sidebar-collapsed'

/**
 * Sidebar desktop & tablet. Tablet (md) bisa diciutkan jadi rel ikon; pilihan diingat per perangkat.
 * Di layar lebar (xl) sidebar selalu terbuka penuh.
 */
export function SideNav({ staff, owner, logo, name, role }: { staff: NavItem[]; owner: NavItem[] | null; logo: React.ReactNode; name: string; role: string }) {
  const path = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try {
      // Belum pernah diatur: iPad potret (lebar < 1024) mulai dengan rel ikon agar konten lebih lega.
      const saved = localStorage.getItem(COLLAPSE_KEY)
      setCollapsed(saved ? saved === '1' : window.innerWidth < 1024)
    } catch {}
  }, [])
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {}
      return !c
    })

  const item = (n: NavItem) => (
    <Link
      key={n.href}
      href={n.href}
      title={n.label}
      aria-current={isActive(path, n.href) ? 'page' : undefined}
      className="group btn-press relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-[#4a5468] hover:bg-navy-100/70 hover:text-navy-900 aria-[current=page]:bg-navy-900 aria-[current=page]:text-white aria-[current=page]:shadow-[0_8px_18px_-10px_rgb(21_35_66/0.7)]"
    >
      <Icon name={n.icon} className="size-[18px] shrink-0" />
      <span className="sidebar-label min-w-0 flex-1 truncate">{n.label}</span>
      <span className="sidebar-label">
        <Badge n={n.badge} />
      </span>
      {collapsed && !!n.badge && <span className="absolute right-1.5 top-1.5 hidden size-2 rounded-full bg-orange-500 md:block xl:hidden" />}
      <PendingDot />
    </Link>
  )
  const group = (t: string) => <span className="sidebar-label px-3 pb-1 pt-4 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8a92a6]">{t}</span>

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className="side-nav sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col gap-3 self-start border-r border-cream-300 bg-white/80 px-3 py-5 backdrop-blur md:flex xl:w-[256px]"
      style={{ transition: 'width 220ms cubic-bezier(0.2,0.7,0.2,1)' }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-1">
        <span className="sidebar-label min-w-0">{logo}</span>
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Buka sidebar' : 'Ciutkan sidebar'}
          aria-expanded={!collapsed}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-500 hover:bg-cream-100 hover:text-navy-900 xl:hidden"
        >
          <Icon name="sidebar" className="size-[18px]" />
        </button>
      </div>
      <nav aria-label="Navigasi utama" className="sidebar-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1">
        {group('Operasional')}
        {staff.map(item)}
        {owner && (
          <>
            {group('Owner')}
            {owner.map(item)}
          </>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-2 rounded-2xl bg-cream-100 p-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-navy-900 font-display text-sm font-bold text-white">{name.slice(0, 1).toUpperCase()}</span>
        <span className="sidebar-label flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="text-xs text-ink-500">{role}</span>
        </span>
        <form action="/api/auth/logout" method="post" className="sidebar-label">
          <button aria-label="Keluar" title="Keluar" className="flex size-9 items-center justify-center rounded-lg text-ink-500 hover:bg-white hover:text-danger-700">
            <Icon name="logout" className="size-[18px]" />
          </button>
        </form>
      </div>
    </aside>
  )
}

/**
 * Navigasi HP: header ringkas di atas, bilah tab bawah untuk modul yang paling sering dipakai,
 * dan laci (bottom sheet) "Menu" berisi semua modul sesuai peran.
 */
export function MobileNav({ logo, staff, owner, name, role, primary }: { logo: React.ReactNode; staff: NavItem[]; owner: NavItem[] | null; name: string; role: string; primary: string[] }) {
  const path = usePathname()
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false) // tetap terpasang selama animasi tutup
  const sheet = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const menuBtn = useRef<HTMLButtonElement>(null)
  const all = [...staff, ...(owner ?? [])]
  const pinned = primary.map((h) => all.find((n) => n.href === h)).filter((n): n is NavItem => !!n)
  const pending = (owner ?? []).reduce((a, n) => a + (n.badge ?? 0), 0)

  useEffect(() => {
    if (open) setShown(true)
  }, [open])

  useGSAP(
    () => {
      if (!shown || !sheet.current || !backdrop.current) return
      const quick = reducedMotion()
      if (open) {
        gsap.fromTo(backdrop.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: quick ? 0 : 0.2 })
        gsap.fromTo(sheet.current, { y: 0, yPercent: 100 }, { yPercent: 0, duration: quick ? 0 : 0.36, ease: 'power3.out' })
        gsap.fromTo(sheet.current.querySelectorAll('[data-sheet-item]'), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: quick ? 0 : 0.25, stagger: 0.015, delay: 0.08 })
      } else {
        gsap.to(backdrop.current, { autoAlpha: 0, duration: quick ? 0 : 0.18 })
        gsap.to(sheet.current, { yPercent: 100, duration: quick ? 0 : 0.24, ease: 'power2.in', onComplete: () => setShown(false) })
      }
    },
    { dependencies: [open, shown] },
  )

  // Tutup saat pindah halaman.
  useEffect(() => setOpen(false), [path])
  // Escape menutup; gulir halaman dikunci selama laci terbuka.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        menuBtn.current?.focus()
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

  const current = all.filter((n) => isActive(path, n.href)).sort((a, b) => b.href.length - a.href.length)[0]
  const inMenu = !!current && !pinned.some((n) => n.href === current.href)

  return (
    <>
      <header className="sticky top-0 z-40 flex min-h-[3.5rem] items-center justify-between gap-3 border-b border-cream-300 bg-white/85 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] backdrop-blur md:hidden">
        <span className="min-w-0 shrink">{logo}</span>
        {owner && (
          <Link href="/approvals" aria-label={`Persetujuan${pending ? `, ${pending} menunggu` : ''}`} className="relative flex size-11 items-center justify-center rounded-xl text-navy-900">
            <Icon name="shield" className="size-5" />
            {!!pending && <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-orange-500 px-1 text-center text-[10px] font-bold leading-4 text-navy-900">{pending}</span>}
          </Link>
        )}
      </header>

      <nav aria-label="Navigasi cepat" className="fixed inset-x-0 bottom-0 z-40 border-t border-cream-300 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="mx-auto flex max-w-md items-stretch justify-between">
          {pinned.map((n) => (
            <li key={n.href} className="flex-1">
              <Link
                href={n.href}
                aria-current={isActive(path, n.href) && !(n.href === '/' && path !== '/') ? 'page' : undefined}
                className="group flex min-h-[3.6rem] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-ink-500 aria-[current=page]:text-navy-900"
              >
                <span className="flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-200 group-aria-[current=page]:bg-navy-900 group-aria-[current=page]:text-white">
                  <Icon name={n.icon} className="size-[19px]" />
                </span>
                <span className="max-w-full truncate px-0.5">{n.label.split(' ')[0]}</span>
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button
              ref={menuBtn}
              type="button"
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen((v) => !v)}
              className={`group flex min-h-[3.6rem] w-full flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${open || inMenu ? 'text-navy-900' : 'text-ink-500'}`}
            >
              <span className={`relative flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-200 ${open || inMenu ? 'bg-navy-900 text-white' : ''}`}>
                <Icon name={open ? 'close' : 'menu'} className="size-[19px]" />
              </span>
              Menu
            </button>
          </li>
        </ul>
      </nav>

      {shown && (
        <>
          <div ref={backdrop} className="invisible fixed inset-0 z-50 bg-navy-900/45 md:hidden" aria-hidden onClick={() => setOpen(false)} />
          <div
            ref={sheet}
            id="mobile-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Semua menu"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl md:hidden"
          >
            <span aria-hidden className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-cream-300" />
            <div className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-navy-900 font-display font-bold text-white">{name.slice(0, 1).toUpperCase()}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{name}</span>
                <span className="text-xs text-ink-500">{role}</span>
              </span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Tutup menu" className="flex size-10 items-center justify-center rounded-xl bg-cream-100">
                <Icon name="close" className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
              {[{ t: 'Operasional', l: staff }, ...(owner ? [{ t: 'Owner', l: owner }] : [])].map((g) => (
                <div key={g.t} className="flex flex-col gap-2 pb-3">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8a92a6]">{g.t}</span>
                  <div className="grid grid-cols-3 gap-2">
                    {g.l.map((n) => (
                      <Link
                        key={n.href}
                        data-sheet-item
                        href={n.href}
                        onClick={() => isActive(path, n.href) && setOpen(false)}
                        aria-current={isActive(path, n.href) ? 'page' : undefined}
                        className="btn-press relative flex min-h-[5.25rem] flex-col items-center justify-center gap-1.5 rounded-2xl border border-cream-300 bg-cream-50 px-1.5 text-center text-xs font-semibold text-navy-900 aria-[current=page]:border-navy-900 aria-[current=page]:bg-navy-900 aria-[current=page]:text-white"
                      >
                        <Icon name={n.icon} className="size-5" />
                        <span className="leading-tight">{n.label}</span>
                        {!!n.badge && <span className="absolute right-2 top-2"><Badge n={n.badge} /></span>}
                        <span className="absolute left-2 top-2"><PendingDot /></span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <form action="/api/auth/logout" method="post" className="shrink-0 border-t border-cream-300 px-4 py-2">
              <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-danger-700">
                <Icon name="logout" className="size-[18px]" /> Keluar
              </button>
            </form>
          </div>
        </>
      )}
    </>
  )
}
