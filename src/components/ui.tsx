import Link from 'next/link'

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        {eyebrow && <span className="text-sm font-medium text-ink-500">{eyebrow}</span>}
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </header>
  )
}

export function Card({ title, children, className = '', aside }: { title?: string; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5 ${className}`}>
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
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold ${TONES[tone]}`}>{children}</span>
}

export function Note({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warning' }) {
  return (
    <p className={`rounded-lg px-3 py-2.5 text-[13px] leading-relaxed ${tone === 'warning' ? 'bg-warning-100 text-warning-700' : 'bg-cream-100 text-ink-500'}`}>
      {children}
    </p>
  )
}

export function Tabs({ items, active }: { items: { key: string; label: string; href: string }[]; active: string }) {
  return (
    <nav aria-label="Bagian halaman" className="flex gap-1 overflow-x-auto rounded-xl border border-cream-300 bg-white p-1">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? 'page' : undefined}
          className={`flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-sm font-semibold ${t.key === active ? 'bg-navy-900 text-white' : 'text-ink-500 hover:bg-cream-100'}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-1 rounded-xl border border-cream-300 bg-white p-4">
      <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</span>
      <span className="font-display text-xl font-bold">{value}</span>
      {sub && <span className="text-xs text-ink-500">{sub}</span>}
    </div>
  )
}

/** Tabel dengan gulir horizontal di layar sempit. */
export function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-cream-300 text-left text-xs font-bold uppercase tracking-[0.05em] text-ink-500">
            {head.map((h) => (
              <th key={h} className="px-2.5 py-2 font-bold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-[#f1eadc] [&_td]:px-2.5 [&_td]:py-2.5 [&_td]:align-top">
          {hasRows ? (
            children
          ) : (
            <tr>
              <td colSpan={head.length} className="text-center text-ink-500">
                {empty ?? 'Belum ada data.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export const inputCls = 'min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-3 text-sm outline-orange-500'
export const labelCls = 'flex flex-col gap-1.5 text-sm font-semibold'
