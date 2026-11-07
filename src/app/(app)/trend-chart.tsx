'use client'

import { useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { reducedMotion } from '@/components/motion'

export type TrendPoint = { day: string; label: string; omzet: number; laba: number; orders: number }

const rp = (n: number) => (n < 0 ? '−Rp' : 'Rp') + Math.abs(Math.round(n)).toLocaleString('id-ID')
const W = 560
const H = 180
const PAD = { l: 8, r: 8, t: 16, b: 26 }

/** Grafik 7 hari: satu seri per tampilan (Omzet / Laba bersih order), tooltip saat disorot atau disentuh. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [metric, setMetric] = useState<'omzet' | 'laba'>('omzet')
  const [hover, setHover] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const line = useRef<SVGPathElement>(null)
  const area = useRef<SVGPathElement>(null)

  const { path, fill, xy, max } = useMemo(() => {
    const vals = points.map((p) => p[metric])
    const max = Math.max(1, ...vals)
    const min = Math.min(0, ...vals)
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, points.length - 1)
    const y = (v: number) => PAD.t + (1 - (v - min) / (max - min || 1)) * (H - PAD.t - PAD.b)
    const xy = vals.map((v, i) => [x(i), y(v)] as const)
    // Kurva halus (Catmull-Rom → Bézier) agar mirip referensi tanpa melebih-lebihkan nilai.
    let d = `M${xy[0]?.[0] ?? 0},${xy[0]?.[1] ?? 0}`
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] ?? xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] ?? p2
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
      d += ` C${c1[0]},${Math.min(c1[1], H - PAD.b)} ${c2[0]},${Math.min(c2[1], H - PAD.b)} ${p2[0]},${p2[1]}`
    }
    const base = H - PAD.b
    return { path: d, fill: `${d} L${xy.at(-1)?.[0] ?? 0},${base} L${xy[0]?.[0] ?? 0},${base} Z`, xy, max }
  }, [points, metric])

  useGSAP(
    () => {
      if (!line.current || reducedMotion()) return
      const len = line.current.getTotalLength()
      gsap.fromTo(line.current, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1, ease: 'power2.out', clearProps: 'strokeDasharray,strokeDashoffset' })
      gsap.fromTo(area.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8, delay: 0.3 })
    },
    { scope: root, dependencies: [metric] },
  )

  const total = points.reduce((a, p) => a + p[metric], 0)
  const h = hover !== null ? points[hover] : null

  return (
    <div ref={root} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-xs text-ink-500">Total 7 hari · {metric === 'omzet' ? 'Omzet' : 'Laba bersih order'}</span>
          <span className="font-display text-xl font-bold">{rp(total)}</span>
        </div>
        <div role="group" aria-label="Pilih data grafik" className="flex rounded-xl bg-cream-100 p-1 text-xs font-semibold">
          {(['omzet', 'laba'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              className={`min-h-8 rounded-lg px-3 ${metric === m ? 'bg-white text-navy-900 shadow-sm' : 'text-ink-500'}`}
            >
              {m === 'omzet' ? 'Omzet' : 'Laba'}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="img" aria-label={`Grafik ${metric} 7 hari terakhir`} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff851b" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#ff851b" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + g * (H - PAD.t - PAD.b)} y2={PAD.t + g * (H - PAD.t - PAD.b)} stroke="#efe8db" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
          ))}
          <path ref={area} d={fill} fill="url(#trend-fill)" />
          <path ref={line} d={path} fill="none" stroke="#ff851b" strokeWidth={2.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {hover !== null && xy[hover] && (
            <>
              <line x1={xy[hover][0]} x2={xy[hover][0]} y1={PAD.t} y2={H - PAD.b} stroke="#152342" strokeOpacity="0.15" vectorEffect="non-scaling-stroke" />
              <circle cx={xy[hover][0]} cy={xy[hover][1]} r={5} fill="#fff" stroke="#ff851b" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {points.map((p, i) => (
            <rect
              key={p.day}
              x={(xy[i]?.[0] ?? 0) - (W / points.length) / 2}
              y={0}
              width={W / points.length}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onTouchStart={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${p.label}: ${rp(p[metric])}, ${p.orders} order`}
            />
          ))}
        </svg>
        <div className="mt-1 flex justify-between px-1 text-[11px] text-ink-500">
          {points.map((p) => (
            <span key={p.day}>{p.label}</span>
          ))}
        </div>
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-xl bg-navy-900 px-3 py-2 text-xs text-white shadow-lg"
            style={{ left: `${((xy[hover]?.[0] ?? 0) / W) * 100}%` }}
          >
            <span className="block font-semibold">{h.label}</span>
            <span className="block">{rp(h[metric])}</span>
            <span className="block text-[#c5cbd9]">{h.orders} order</span>
          </div>
        )}
      </div>
      {max <= 1 && <span className="text-xs text-ink-500">Belum ada order terkonfirmasi dalam 7 hari terakhir.</span>}
    </div>
  )
}
