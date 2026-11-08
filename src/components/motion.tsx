'use client'

import { useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

/** Gerak dimatikan bila pengguna meminta gerak minimal; semua animasi di sini memeriksa ini. */
// Juga dilewati bila halaman sedang di tab latar belakang: browser menahan animasi di sana, dan konten tidak boleh
// tertahan tak terlihat sampai tab dibuka lagi.
export const reducedMotion = () =>
  typeof window !== 'undefined' && (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState === 'hidden')

// Setelah animasi pertama menyiapkan keadaan awalnya, CSS tidak lagi perlu menyembunyikan [data-reveal].
const markReady = () => document.documentElement.classList.add('motion-ready')

/**
 * Transisi halaman: konten masuk halus saat berpindah halaman atau tab (?mode=, ?tab=, ?view=), lalu kartu dan
 * baris bertanda [data-reveal] muncul berurutan. Hanya opacity/transform; transform dibersihkan setelah selesai
 * agar elemen `position: fixed` di dalam halaman tetap menempel ke layar.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const qs = useSearchParams().toString()
  const root = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const items = gsap.utils.toArray<HTMLElement>('[data-reveal]', root.current)
      if (reducedMotion()) {
        gsap.set(items, { autoAlpha: 1 })
        markReady()
        return
      }
      gsap.fromTo(root.current, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power2.out', clearProps: 'transform' })
      if (items.length)
        gsap.fromTo(
          items,
          { autoAlpha: 0, y: 14 },
          { autoAlpha: 1, y: 0, duration: 0.42, ease: 'power3.out', stagger: { each: 0.045, amount: 0.35 }, clearProps: 'transform' },
        )
      markReady()
    },
    { scope: root, dependencies: [path, qs], revertOnUpdate: false },
  )

  return (
    <div ref={root} key={`${path}?${qs}`}>
      {children}
    </div>
  )
}

/**
 * Daftar yang isinya berubah di tempat (filter, pencarian, baris baru): anak bertanda [data-stagger] muncul berurutan
 * setiap kali `watch` berubah. Tidak menyentuh elemen form, jadi mengetik tidak pernah terganggu.
 */
export function Stagger({ watch, children, className, as: Tag = 'div' }: { watch: unknown; children: React.ReactNode; className?: string; as?: 'div' | 'ul' }) {
  const root = useRef<HTMLElement>(null)
  useGSAP(
    () => {
      if (reducedMotion()) return
      const items = gsap.utils.toArray<HTMLElement>('[data-stagger]', root.current).slice(0, 40)
      if (items.length) gsap.fromTo(items, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.32, ease: 'power2.out', stagger: 0.03, clearProps: 'transform' })
    },
    { scope: root, dependencies: [watch] },
  )
  return (
    <Tag ref={root as React.Ref<never>} className={className}>
      {children}
    </Tag>
  )
}

/** Angka statistik yang menghitung naik saat pertama tampil. Nilai akhir selalu persis sama dengan data. */
export function CountUp({ value, format = 'number' }: { value: number; format?: 'number' | 'rupiah' }) {
  const el = useRef<HTMLSpanElement>(null)
  const fmt = (n: number) => (format === 'rupiah' ? (n < 0 ? '−Rp' : 'Rp') + Math.abs(Math.round(n)).toLocaleString('id-ID') : Math.round(n).toLocaleString('id-ID'))
  useGSAP(
    () => {
      if (!el.current || reducedMotion() || !value) return
      const o = { n: 0 }
      gsap.to(o, {
        n: value,
        duration: 0.9,
        ease: 'power2.out',
        onUpdate: () => { if (el.current) el.current.textContent = fmt(o.n) },
        onComplete: () => { if (el.current) el.current.textContent = fmt(value) },
      })
    },
    { dependencies: [value] },
  )
  return <span ref={el}>{fmt(value)}</span>
}

/** Bilah progres yang mengisi dari nol saat tampil. */
export function Progress({ value, className = 'bg-orange-500', label }: { value: number; className?: string; label?: string }) {
  const bar = useRef<HTMLSpanElement>(null)
  const pct = Math.max(0, Math.min(100, value))
  useGSAP(
    () => {
      if (!bar.current || reducedMotion()) return
      gsap.fromTo(bar.current, { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: 'power3.out', delay: 0.15 })
    },
    { dependencies: [pct] },
  )
  return (
    <span role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label} className="block h-2 w-full overflow-hidden rounded-full bg-cream-100">
      <span ref={bar} className={`block h-full origin-left rounded-full ${className}`} style={{ width: `${pct}%` }} />
    </span>
  )
}

/** Batang grafik tumbuh dari dasar saat tampil (anak bertanda [data-bar]). */
export function GrowBars({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const root = useRef<HTMLDivElement>(null)
  useGSAP(
    () => {
      if (reducedMotion()) return
      gsap.from(gsap.utils.toArray<HTMLElement>('[data-bar]', root.current), { scaleY: 0, transformOrigin: (_: number, el: HTMLElement) => (el.dataset.bar === 'neg' ? '50% 0%' : '50% 100%'), duration: 0.6, ease: 'power3.out', stagger: 0.04, clearProps: 'transform' })
    },
    { scope: root },
  )
  return (
    <div ref={root} className={className} {...rest}>
      {children}
    </div>
  )
}

/**
 * Pinggiran bercahaya yang berputar pelan mengelilingi elemen, plus kilau (shimmer) yang sesekali melintas.
 * Pakai hanya untuk beberapa elemen penting. Berhenti saat elemen tidak terlihat di layar (hemat baterai iPad/HP)
 * dan diam sepenuhnya bila pengguna meminta gerak minimal.
 */
export function GlowBorder({
  children,
  className = '',
  tone = 'green',
  dark = false,
  as: Tag = 'div',
  ...rest
}: { children: React.ReactNode; className?: string; tone?: 'green' | 'orange' | 'sky'; dark?: boolean; as?: 'div' | 'section' | 'aside' } & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  const root = useRef<HTMLElement>(null)
  const shine = useRef<HTMLSpanElement>(null)
  useGSAP(
    () => {
      const el = root.current
      if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const tl = gsap.timeline({ paused: true })
      tl.fromTo(el, { '--glow-angle': '0deg' }, { '--glow-angle': '360deg', duration: 6, ease: 'none', repeat: -1 }, 0)
      if (shine.current)
        tl.fromTo(shine.current, { xPercent: -120 }, { xPercent: 330, duration: 1.3, ease: 'power2.inOut', repeat: -1, repeatDelay: 6.5, delay: 1.2 }, 0)
      const io = new IntersectionObserver(([e]) => (e.isIntersecting ? tl.play() : tl.pause()))
      io.observe(el)
      return () => io.disconnect()
    },
    { scope: root },
  )
  return (
    <Tag ref={root as React.Ref<never>} data-glow={tone === 'green' ? undefined : tone} className={`glow-border ${dark ? 'on-dark' : ''} ${className}`} {...rest}>
      <span aria-hidden className="glow-shimmer-clip"><span ref={shine} className="glow-shimmer" /></span>
      {children}
    </Tag>
  )
}
