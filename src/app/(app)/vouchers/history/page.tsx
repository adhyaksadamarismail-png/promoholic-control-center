import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase/server'
import { Card, EmptyState, PageHeader, Pill, Table, btnDark, btnSecondary, inputCls } from '@/components/ui'
import { Icon, type IconName } from '@/components/icons'
import { addDays, dateLabel, isYmd, jktDate, jktDateTime, jktTime } from '@/lib/format'
import { LEDGER_REASON, VOUCHER_STATUS, type VoucherStatus } from '@/lib/inventory'
import { loadHistory, loadVoucherTrail, type HistoryRow } from '@/lib/history'

export const dynamic = 'force-dynamic'

type SP = { from?: string; to?: string; brand?: string; event?: string; q?: string; type?: string; status?: string; v?: string; tampil?: string }

const TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = {
  restock: 'success', use: 'info', reserve: 'warning', release: 'neutral', reversal: 'warning', expire: 'danger', adjust: 'danger',
}
// Titik timeline per peristiwa: warna + ikon, jadi tidak bergantung pada warna saja.
const DOT: Record<string, { icon: IconName; cls: string }> = {
  restock: { icon: 'restock', cls: 'bg-mint-100 text-mint-500' },
  use: { icon: 'cart', cls: 'bg-sky-100 text-sky-500' },
  reserve: { icon: 'clock', cls: 'bg-warning-100 text-warning-700' },
  release: { icon: 'close', cls: 'bg-[#eef0f4] text-ink-500' },
  reversal: { icon: 'history', cls: 'bg-peach-100 text-peach-500' },
  expire: { icon: 'alert', cls: 'bg-danger-100 text-danger-700' },
  adjust: { icon: 'settings', cls: 'bg-lavender-100 text-lavender-500' },
}
const STATUS_FILTER: VoucherStatus[] = ['available', 'used', 'reserved', 'broken', 'expired']

function Event({ r, trail, href }: { r: HistoryRow; trail?: boolean; href: (v: string) => string }) {
  const dot = DOT[r.reason] ?? DOT.release
  const st = VOUCHER_STATUS[r.status as VoucherStatus]
  return (
    <li data-reveal className="group/ev relative flex gap-3 pb-4 last:pb-0">
      {/* Garis timeline */}
      <span aria-hidden className="absolute bottom-0 left-[1.125rem] top-10 w-px bg-cream-300 group-last/ev:hidden" />
      <span className={`icon-tile relative z-[1] size-9 shrink-0 rounded-full ring-4 ring-white ${dot.cls}`}>
        <Icon name={dot.icon} className="size-[18px]" />
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-1 rounded-xl border p-3 text-sm ${r.cancelChain ? 'border-warning-700/25 bg-warning-100/50' : 'border-cream-300 bg-white'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">{LEDGER_REASON[r.reason] ?? r.reason}</span>
          <span className="text-xs text-ink-500">{trail ? jktDateTime(r.at) : jktTime(r.at)}</span>
        </div>
        {!trail && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={href(r.voucherCode)} scroll={false} className="font-mono text-[13px] font-semibold text-navy-900 underline-offset-4 hover:underline">{r.voucherCode}</Link>
            <span className="text-xs text-ink-500">
              {r.accountId ? <Link href={`/accounts/${r.accountId}`} className="font-mono hover:underline">{r.accountCode}</Link> : r.accountCode} · {r.typeName}
            </span>
          </span>
        )}
        {(r.customer || r.orderCode) && (
          <span className="text-xs">
            {r.customer && <>{r.customer} · <span className="font-mono">{r.wa}</span></>}
            {r.orderCode && <span className="font-mono"> · {r.orderCode}</span>}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
          <span>Oleh {r.actor}</span>
          {st && <Pill tone={st.tone}>{st.label}</Pill>}
          {r.note && <span>· {r.note}</span>}
        </span>
      </div>
    </li>
  )
}

export default async function VoucherHistoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const today = jktDate()
  const to = isYmd(sp.to) ? sp.to : today
  const from = isYmd(sp.from) ? sp.from : addDays(to, -6)
  const status = STATUS_FILTER.includes(sp.status as VoucherStatus) ? sp.status : undefined
  const supabase = await createSessionClient()
  const [{ data: brands }, { data: types }, { data: role }, rows, trail] = await Promise.all([
    supabase.from('brands').select('id, name').order('name'),
    supabase.from('voucher_types').select('id, brand_id, code, name, sort_order').order('sort_order'),
    supabase.rpc('current_app_role'),
    loadHistory(supabase, { from, to, brand: sp.brand, event: sp.event, q: sp.q, type: sp.type, status }),
    sp.v ? loadVoucherTrail(supabase, sp.v.trim().toUpperCase()) : Promise.resolve(null),
  ])
  const base = Object.fromEntries(Object.entries({ ...sp, from, to }).filter(([, v]) => v)) as Record<string, string>
  const link = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams(base)
    Object.entries(o).forEach(([k, v]) => (v ? u.set(k, v) : u.delete(k)))
    return `/vouchers/history?${u.toString()}`
  }
  const exportQs = new URLSearchParams(Object.entries({ from, to, brand: sp.brand, event: sp.event, q: sp.q, type: sp.type, status }).filter(([, v]) => v) as [string, string][]).toString()
  const asTable = sp.tampil === 'tabel'
  const byDay = rows.reduce<Record<string, HistoryRow[]>>((m, r) => ((m[jktDate(r.at)] ??= []).push(r), m), {})
  const counts = Object.keys(LEDGER_REASON).map((k) => ({ k, n: rows.filter((r) => r.reason === k).length })).filter((x) => x.n || x.k === sp.event)
  const typeOptions = (types ?? []).filter((t) => !sp.brand || t.brand_id === sp.brand)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow={`Log tidak dapat diubah atau dihapus · ${dateLabel(from)} – ${dateLabel(to)}`} title="Riwayat Voucher">
        <a href={`/vouchers/history/export?${exportQs}`} className={btnSecondary}>Export CSV</a>
      </PageHeader>

      <form role="search" data-reveal className="grid grid-cols-2 items-end gap-2 rounded-2xl border border-cream-300 bg-white p-4 md:grid-cols-4 [&_input]:w-full [&_label]:min-w-0 [&_select]:w-full">
        <label className="relative col-span-2 flex flex-col gap-1.5 text-sm font-semibold md:col-span-4">
          Cari
          <span className="relative">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input name="q" defaultValue={sp.q} placeholder="Kode voucher, ID akun, order, customer" className={`${inputCls} w-full pl-9 text-base`} />
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Brand
          <select name="brand" defaultValue={sp.brand ?? ''} className={inputCls}>
            <option value="">Semua brand</option>
            {(brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Jenis voucher
          <select name="type" defaultValue={sp.type ?? ''} className={inputCls}>
            <option value="">Semua jenis</option>
            {typeOptions.map((t) => <option key={t.id} value={t.id}>{t.brand_id} · {t.code} · {t.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Status sesudahnya
          <select name="status" defaultValue={status ?? ''} className={inputCls}>
            <option value="">Semua status</option>
            {STATUS_FILTER.map((k) => <option key={k} value={k}>{VOUCHER_STATUS[k].label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Peristiwa
          <select name="event" defaultValue={sp.event ?? ''} className={inputCls}>
            <option value="">Semua peristiwa</option>
            {Object.entries(LEDGER_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">Dari<input type="date" name="from" defaultValue={from} max={today} className={inputCls} /></label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">Sampai<input type="date" name="to" defaultValue={to} max={today} className={inputCls} /></label>
        <div className="col-span-2 flex items-center gap-2 md:col-span-2">
          <button className={`${btnDark} flex-1`}>Terapkan</button>
          <Link href="/vouchers/history" className="flex min-h-11 items-center px-2 text-sm font-semibold text-orange-700">Reset</Link>
        </div>
      </form>

      {trail !== null && sp.v && (
        <Card
          title={`Perjalanan voucher ${sp.v.toUpperCase()}`}
          aside={<Link href={link({ v: undefined })} scroll={false} className="flex min-h-9 items-center gap-1 text-sm font-semibold text-orange-700"><Icon name="close" className="size-4" /> Tutup</Link>}
        >
          {!trail ? (
            <EmptyState title="Voucher tidak ditemukan" icon="search">Periksa kode voucher, mis. V-KK0187-A.</EmptyState>
          ) : (
            <>
              <span className="flex flex-wrap items-center gap-2 text-sm">
                Status sekarang <Pill tone={VOUCHER_STATUS[trail.voucher.status as VoucherStatus]?.tone ?? 'neutral'}>{VOUCHER_STATUS[trail.voucher.status as VoucherStatus]?.label ?? trail.voucher.status}</Pill>
                {trail.voucher.account_id && <Link href={`/accounts/${trail.voucher.account_id}`} className="font-semibold text-orange-700">Buka akun</Link>}
              </span>
              <ol className="flex flex-col">
                {trail.rows.map((r) => <Event key={r.id} r={r} trail href={(v) => link({ v })} />)}
              </ol>
            </>
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {counts.map(({ k, n }) => {
          const on = sp.event === k
          return (
            <Link
              key={k}
              href={link({ event: on ? undefined : k })}
              scroll={false}
              aria-current={on ? 'true' : undefined}
              className={`btn-press flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold ${on ? 'border-navy-900 bg-navy-900 text-white' : 'border-cream-300 bg-white text-ink-500 hover:text-navy-900'}`}
            >
              <span className={`size-2 rounded-full ${(DOT[k] ?? DOT.release).cls.split(' ')[0]}`} />
              {LEDGER_REASON[k]} <b>{n}</b>
            </Link>
          )
        })}
        <nav aria-label="Tampilan" className="ml-auto hidden rounded-xl bg-white p-1 ring-1 ring-cream-300 md:flex">
          {[{ k: undefined, l: 'Timeline' }, { k: 'tabel', l: 'Tabel' }].map((t) => {
            const on = (t.k === 'tabel') === asTable
            return (
              <Link key={t.l} href={link({ tampil: t.k })} scroll={false} aria-current={on ? 'page' : undefined} className={`btn-press flex min-h-8 items-center rounded-lg px-3 text-xs font-semibold ${on ? 'bg-navy-900 text-white' : 'text-ink-500 hover:text-navy-900'}`}>
                {t.l}
              </Link>
            )
          })}
        </nav>
      </div>

      {!rows.length ? (
        <EmptyState title="Tidak ada peristiwa untuk filter ini" icon="history">Perlebar rentang tanggal atau hapus sebagian filter.</EmptyState>
      ) : (
        <>
          {/* Timeline per hari (HP selalu; layar lebar bila dipilih). */}
          <div className={`flex flex-col gap-5 ${asTable ? 'md:hidden' : ''}`}>
            {Object.entries(byDay).map(([day, list]) => (
              <section key={day} className="flex flex-col gap-3">
                <h2 className="sticky top-[calc(3.6rem+env(safe-area-inset-top))] z-[2] -mx-1 flex items-center gap-2 bg-cream-100/90 px-1 py-1 font-display text-sm font-semibold backdrop-blur md:top-0">
                  {dateLabel(day, 'long')}
                  <span className="text-xs font-normal text-ink-500">{list.length} peristiwa</span>
                </h2>
                <ol className="flex flex-col">
                  {list.map((r) => <Event key={r.id} r={r} href={(v) => link({ v })} />)}
                </ol>
              </section>
            ))}
          </div>

          {asTable && (
            <div className="hidden md:block">
              <Card>
                <Table head={['Waktu', 'Peristiwa', 'Voucher', 'Akun · jenis', 'Customer', 'WhatsApp', 'Order', 'Pelaku', 'Status voucher', 'Alasan / catatan']}>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.cancelChain ? 'bg-warning-100/50 [&>td:first-child]:!bg-[#fdf3e3]' : ''}>
                      <td className="whitespace-nowrap">{jktDateTime(r.at)}</td>
                      <td><Pill tone={TONE[r.reason] ?? 'neutral'}>{LEDGER_REASON[r.reason] ?? r.reason}</Pill></td>
                      <td className="whitespace-nowrap font-mono text-[13px]"><Link href={link({ v: r.voucherCode })} scroll={false}>{r.voucherCode}</Link></td>
                      <td><span className="font-mono text-[13px]">{r.accountCode}</span><div className="text-xs text-ink-500">{r.typeName}</div></td>
                      <td>{r.customer ?? '—'}</td>
                      <td className="whitespace-nowrap font-mono text-[13px]">{r.wa ?? '—'}</td>
                      <td className="whitespace-nowrap font-mono text-[13px]">{r.orderCode ?? r.ref ?? '—'}</td>
                      <td>{r.actor}</td>
                      <td>{VOUCHER_STATUS[r.status as VoucherStatus]?.label ?? r.status}</td>
                      <td className="text-ink-500">{r.note ?? '—'}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>
          )}
        </>
      )}
      <p className="text-xs text-ink-500">
        Klik kode voucher untuk melihat seluruh perjalanannya. Latar krem = satu rangkaian pembatalan resmi: pemakaian lama tetap tercatat; pembatalan menambah
        peristiwa baru, bukan menghapus. Maksimal 500 peristiwa per tampilan — persempit tanggal bila perlu.
        {role !== 'owner' && ' Nomor WhatsApp customer order admin lain disamarkan.'}
      </p>
    </div>
  )
}
