'use client'

import Link from 'next/link'
import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { reducedMotion } from './motion'

export type TabItem = { key: string; label: string; href: string; badge?: number }

/**
 * Tab berbasis tautan (state di URL, jadi bisa dibagikan & tombol kembali tetap bekerja).
 * Penanda aktif bergeser ke tab yang diklik seketika, sebelum halaman tujuan selesai dimuat.
 */
export function Tabs({ items, active }: { items: TabItem[]; active: string }) {
  const root = useRef<HTMLElement>(null)
  const ind = useRef<HTMLSpanElement>(null)

  const place = (el: HTMLElement | null | undefined, animate: boolean) => {
    if (!el || !ind.current || !root.current) return
    const box = { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
    if (animate && !reducedMotion()) gsap.to(ind.current, { ...box, duration: 0.32, ease: 'power3.out' })
    else gsap.set(ind.current, box)
    root.current.dataset.ready = '1'
  }

  const { contextSafe } = useGSAP(
    () => {
      const sync = () => place(root.current?.querySelector<HTMLElement>('[aria-current="page"]'), false)
      sync()
      // Ukur ulang saat font selesai dimuat atau lebar berubah, supaya penanda selalu pas di bawah tab aktif.
      document.fonts?.ready.then(sync)
      const ro = new ResizeObserver(sync)
      if (root.current) ro.observe(root.current)
      return () => ro.disconnect()
    },
    { scope: root, dependencies: [active] },
  )
  const onPick = contextSafe((e: React.MouseEvent<HTMLAnchorElement>) => {
    place(e.currentTarget, true)
    root.current?.querySelectorAll('a').forEach((a) => a.classList.toggle('tab-picked', a === e.currentTarget))
  })

  return (
    <nav ref={root} aria-label="Bagian halaman" className="group/tabs relative flex gap-1 overflow-x-auto rounded-2xl border border-cream-300 bg-white p-1.5 shadow-[var(--shadow-card)]">
      <span ref={ind} aria-hidden className="tab-indicator left-0 top-0 size-0" />
      {items.map((t) => {
        const on = t.key === active
        return (
          <Link
            key={t.key}
            href={t.href}
            scroll={false}
            onClick={onPick}
            aria-current={on ? 'page' : undefined}
            className={`group relative z-[1] flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold transition-colors duration-200 [&.tab-picked]:text-white ${on ? 'bg-navy-900 text-white group-data-[ready]/tabs:bg-transparent' : 'text-ink-500 hover:text-navy-900'}`}
          >
            {t.label}
            {!!t.badge && <span className="rounded-full bg-orange-500 px-1.5 text-[11px] font-bold text-navy-900">{t.badge}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
