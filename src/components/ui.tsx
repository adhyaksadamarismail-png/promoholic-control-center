import { Icon, type IconName } from './icons'
import { CountUp } from './motion'

export { Tabs } from './tabs'

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        {eyebrow && <span className="text-sm font-medium text-ink-500">{eyebrow}</span>}
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[1.75rem]">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  )
}

export function Card({ title, children, className = '', aside }: { title?: string; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <section data-reveal className={`card-hover flex min-w-0 flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5 ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="font-display text-base font-semibold">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

const TONES = {
  neutral: 'bg-[#eef0f4] text-[#3b4559]',
  info: 'bg-navy-100 text-navy-700',
  success: 'bg-success-100 text-success-700',
  warning: 'bg-warning-100 text-warning-700',
  danger: 'bg-danger-100 text-danger-700',
  orange: 'bg-orange-100 text-orange-700',
}
export type Tone = keyof typeof TONES

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold transition-colors duration-200 ${TONES[tone]}`}>
      {tone !== 'neutral' && tone !== 'info' && <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  )
}

export function Note({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' }) {
  return (
    <p className={`flex gap-2 rounded-xl px-3.5 py-3 text-[13px] leading-relaxed ${tone === 'warning' ? 'bg-warning-100 text-warning-700' : 'bg-white/70 text-ink-500 ring-1 ring-cream-300'}`}>
      <Icon name={tone === 'warning' ? 'alert' : 'info'} className="mt-px size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** Aksen pastel untuk ubin ikon; dipilih per kartu agar dasbor tidak terlalu ramai. */
export const ACCENTS = {
  lavender: 'bg-lavender-100 text-lavender-500',
  mint: 'bg-mint-100 text-mint-500',
  peach: 'bg-peach-100 text-peach-500',
  sky: 'bg-sky-100 text-sky-500',
  navy: 'bg-navy-100 text-navy-700',
} as const
export type Accent = keyof typeof ACCENTS
const ACCENT_ORDER: Accent[] = ['lavender', 'mint', 'peach', 'sky']

// Angka dan nominal rupiah dianimasikan menghitung naik; nilai akhirnya tetap teks yang sama persis.
function animated(value: React.ReactNode) {
  if (typeof value === 'number') return <CountUp value={value} />
  if (typeof value === 'string' && /^−?Rp[\d.]+$/.test(value)) {
    const n = Number(value.replace(/[^\d]/g, '')) * (value.startsWith('−') ? -1 : 1)
    return <CountUp value={n} format="rupiah" />
  }
  return value
}

// Aksen dipilih dari label (stabil di setiap render, tanpa harus diatur di tiap halaman).
const accentOf = (label: string) => ACCENT_ORDER[[...label].reduce((n, c) => n + c.charCodeAt(0), 0) % ACCENT_ORDER.length]
export function Stat({ label, value, sub, icon, accent }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon?: IconName; accent?: Accent }) {
  const a = accent ?? accentOf(label)
  return (
    <div data-reveal className="card-hover flex min-w-[150px] flex-1 flex-col gap-1 rounded-2xl border border-cream-300 bg-white p-3.5 sm:p-4">
      <span className="flex items-center gap-2">
        {icon && (
          <span className={`icon-tile size-8 ${ACCENTS[a]}`}>
            <Icon name={icon} className="size-4" />
          </span>
        )}
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-500 sm:text-xs">{label}</span>
      </span>
      <span className="mt-0.5 font-display text-lg font-bold sm:text-[1.35rem]">{animated(value)}</span>
      {sub && <span className="text-xs text-ink-500">{sub}</span>}
    </div>
  )
}

/** Keadaan kosong yang menjelaskan apa yang bisa dilakukan selanjutnya. */
export function EmptyState({ title, children, icon = 'box' }: { title: string; children?: React.ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-8 text-center">
      <span className={`icon-tile size-11 ${ACCENTS.lavender}`}>
        <Icon name={icon} className="size-5" />
      </span>
      <span className="font-display text-sm font-semibold">{title}</span>
      {children && <span className="max-w-sm text-xs text-ink-500">{children}</span>}
    </div>
  )
}

/** Kerangka pemuatan. */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <span aria-hidden className={`skeleton block ${className}`} />
}

// Kolom pertama menempel di kiri saat tabel digeser, agar tiap baris tetap terbaca di HP.
const STICKY_FIRST =
  '[&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-[1] [&_td:first-child]:bg-white [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-[1] [&_th:first-child]:bg-cream-50'

/** Tabel dengan gulir horizontal di layar sempit. */
export function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children
  return (
    <div className="flex flex-col gap-1">
      {hasRows && head.length > 4 && <span className="text-xs text-ink-500 sm:hidden">Geser tabel ke samping untuk kolom lain →</span>}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className={`w-full min-w-[640px] border-separate border-spacing-0 text-sm ${STICKY_FIRST}`}>
          <thead>
            <tr className="text-left text-[11px] font-bold uppercase tracking-[0.06em] text-ink-500">
              {head.map((h, i) => (
                <th key={h || `kolom-${i}`} className="border-y border-cream-300 bg-cream-50 px-2.5 py-2.5 font-bold first:rounded-l-xl first:border-l last:rounded-r-xl last:border-r">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="[&>tr]:transition-colors [&>tr:hover]:bg-cream-50/70 [&_td]:border-b [&_td]:border-[#f3ede2] [&_td]:px-2.5 [&_td]:py-3 [&_td]:align-top [&_td>a]:inline-flex [&_td>a]:min-h-8 [&_td>a]:items-center">
            {hasRows ? (
              children
            ) : (
              <tr>
                <td colSpan={head.length} className="py-8 text-center text-ink-500">
                  {empty ?? 'Belum ada data.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export const inputCls = 'min-h-11 rounded-xl border border-[#dcd2bf] bg-white px-3.5 text-sm outline-orange-500'
export const labelCls = 'flex flex-col gap-1.5 text-sm font-semibold'
/** Tombol standar: utama (oranye), sekunder (garis), gelap (navy). */
export const btnPrimary = 'btn-press inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-orange-500 px-5 text-sm font-semibold text-navy-900 shadow-[0_6px_16px_-8px_rgb(255_133_27/0.8)] hover:bg-[#ff9433] disabled:bg-[#e7e2d8] disabled:text-[#6e7689] disabled:shadow-none'
export const btnSecondary = 'btn-press inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-cream-300 bg-white px-4 text-sm font-semibold text-navy-900 hover:border-[#dcd2bf] hover:bg-cream-50 disabled:opacity-50'
export const btnDark = 'btn-press inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-navy-900 px-4 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50'

/** Judul langkah bernomor untuk form panjang (order, restock). */
export function StepTitle({ n, children, hint }: { n: number; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-navy-900 font-display text-sm font-semibold text-white">{n}</span>
      <span className="font-display text-base font-semibold">{children}</span>
      {hint && <span className="text-xs text-ink-500">{hint}</span>}
    </span>
  )
}
