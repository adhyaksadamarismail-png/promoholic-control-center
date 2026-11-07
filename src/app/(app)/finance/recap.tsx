import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Card, EmptyState, Note, Pill, Table } from '@/components/ui'
import { addDays, jktDateTime, rupiah } from '@/lib/format'
import { periodRange, type Period } from '@/lib/finance'

type Order = {
  id: string
  code: string
  confirmed_at: string
  customer_name: string
  admin_id: string
  sell_price: number
  price_after_discount: number
  allocated_cost: number
  gross_profit: number
  extra_cost: number
  net_profit: number
  needs_review: boolean
  accounts: { brand_id: string; account_code: string } | { brand_id: string; account_code: string }[] | null
  vouchers: { code: string } | { code: string }[] | null
}
const one = <T,>(v: T | T[] | null) => (Array.isArray(v) ? v[0] ?? null : v)
const PAGE = 50

/**
 * Rekap transaksi per brand dan riwayat order periode berjalan. Semua angka dari snapshot order terkonfirmasi
 * (nilai yang sama dipakai laporan laba rugi), tanpa dihitung ulang.
 */
export async function FinanceRecap({ supabase, p, d, brand, page, brands, profiles }: {
  supabase: SupabaseClient
  p: Period
  d: string
  brand?: string
  page: number
  brands: { id: string; name: string }[]
  profiles: { id: string; full_name: string }[]
}) {
  const [s, e] = periodRange(p, d)
  const { data } = await supabase
    .from('orders')
    .select('id, code, confirmed_at, customer_name, admin_id, sell_price, price_after_discount, allocated_cost, gross_profit, extra_cost, net_profit, needs_review, accounts(brand_id, account_code), vouchers(code)')
    .eq('status', 'confirmed')
    .gte('confirmed_at', `${s}T00:00:00+07:00`)
    .lt('confirmed_at', `${addDays(e, 1)}T00:00:00+07:00`)
    .order('confirmed_at', { ascending: false })
  const all = (data ?? []) as unknown as Order[]
  const brandOf = (o: Order) => one(o.accounts)?.brand_id ?? '—'
  const rows = brands
    .map((b) => {
      const os = all.filter((o) => brandOf(o) === b.id)
      const sum = (k: keyof Order) => os.reduce((a, o) => a + Number(o[k]), 0)
      return { id: b.id, name: b.name, n: os.length, revenue: sum('sell_price'), merchant: sum('price_after_discount'), cost: sum('allocated_cost'), gross: sum('gross_profit'), extra: sum('extra_cost'), net: sum('net_profit') }
    })
    .filter((r) => r.n)
  const total = rows.reduce(
    (a, r) => ({ n: a.n + r.n, revenue: a.revenue + r.revenue, merchant: a.merchant + r.merchant, cost: a.cost + r.cost, gross: a.gross + r.gross, extra: a.extra + r.extra, net: a.net + r.net }),
    { n: 0, revenue: 0, merchant: 0, cost: 0, gross: 0, extra: 0, net: 0 },
  )
  const list = brand ? all.filter((o) => brandOf(o) === brand) : all
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const pg = Math.min(Math.max(1, page), pages)
  const shown = list.slice((pg - 1) * PAGE, pg * PAGE)
  const href = (o: { brand?: string; page?: number }) => {
    const u = new URLSearchParams({ p, d, view: 'rekap' })
    if (o.brand ?? brand) u.set('brand', (o.brand ?? brand)!)
    if (o.brand === '') u.delete('brand')
    if (o.page && o.page > 1) u.set('page', String(o.page))
    return `/finance?${u.toString()}`
  }
  const nameOf = (id: string) => profiles.find((x) => x.id === id)?.full_name ?? '—'
  const maxRev = Math.max(1, ...rows.map((r) => r.revenue))

  return (
    <div className="flex flex-col gap-4">
      <Card title="Rekap per brand" aside={<span className="text-xs text-ink-500">{total.n} order terkonfirmasi</span>}>
        {!rows.length ? (
          <EmptyState title="Belum ada order terkonfirmasi pada periode ini" icon="receipt" />
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:hidden">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={href({ brand: r.id })} scroll={false} className="card-hover flex flex-col gap-2 rounded-xl border border-cream-300 bg-white p-3.5">
                    <span className="flex items-center justify-between"><b>{r.name}</b><span className="text-xs text-ink-500">{r.n} order</span></span>
                    <span className="grid grid-cols-3 gap-2 text-xs">
                      <span className="flex flex-col"><span className="text-ink-500">Omzet</span><b className="text-sm">{rupiah(r.revenue)}</b></span>
                      <span className="flex flex-col"><span className="text-ink-500">HPP</span><b className="text-sm">{rupiah(r.merchant + r.cost)}</b></span>
                      <span className="flex flex-col"><span className="text-ink-500">Laba order</span><b className="text-sm text-success-700">{rupiah(r.net)}</b></span>
                    </span>
                    <span className="block h-1.5 overflow-hidden rounded-full bg-cream-100"><span className="block h-full rounded-full bg-gradient-to-r from-lavender-500 to-orange-500" style={{ width: `${(r.revenue / maxRev) * 100}%` }} /></span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden lg:block">
              <Table head={['Brand', 'Order', 'Omzet', 'Bayar merchant', 'Modal voucher', 'HPP', 'Laba kotor', 'Biaya tambahan', 'Laba bersih order']}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-semibold"><Link href={href({ brand: r.id })} scroll={false} className="underline-offset-4 hover:underline">{r.name}</Link></td>
                    <td>{r.n}</td>
                    <td>{rupiah(r.revenue)}</td>
                    <td>{rupiah(r.merchant)}</td>
                    <td>{rupiah(r.cost)}</td>
                    <td>{rupiah(r.merchant + r.cost)}</td>
                    <td>{rupiah(r.gross)}</td>
                    <td>{rupiah(r.extra)}</td>
                    <td className="font-semibold">{rupiah(r.net)}</td>
                  </tr>
                ))}
                <tr className="bg-cream-50 font-semibold">
                  <td>Total</td>
                  <td>{total.n}</td>
                  <td>{rupiah(total.revenue)}</td>
                  <td>{rupiah(total.merchant)}</td>
                  <td>{rupiah(total.cost)}</td>
                  <td>{rupiah(total.merchant + total.cost)}</td>
                  <td>{rupiah(total.gross)}</td>
                  <td>{rupiah(total.extra)}</td>
                  <td>{rupiah(total.net)}</td>
                </tr>
              </Table>
            </div>
          </>
        )}
        <Note>Laba bersih order = laba kotor − biaya tambahan order, sebelum beban kedaluwarsa, uang saku & bonus, dan biaya operasional (lihat Ringkasan).</Note>
      </Card>

      <Card title="Histori transaksi" aside={<span className="text-xs text-ink-500">{list.length} order{brand ? ` · ${brands.find((b) => b.id === brand)?.name}` : ''}</span>}>
        <nav aria-label="Filter brand" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {[{ id: '', name: 'Semua brand' }, ...brands].map((b) => {
            const on = (brand ?? '') === b.id
            return (
              <Link
                key={b.id || 'all'}
                href={href({ brand: b.id, page: 1 })}
                scroll={false}
                aria-current={on ? 'page' : undefined}
                className={`btn-press flex min-h-9 shrink-0 items-center rounded-full border px-3.5 text-sm font-semibold ${on ? 'border-navy-900 bg-navy-900 text-white' : 'border-cream-300 bg-white text-ink-500 hover:text-navy-900'}`}
              >
                {b.name}
              </Link>
            )
          })}
        </nav>
        {!shown.length ? (
          <EmptyState title="Tidak ada order untuk filter ini" icon="receipt" />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-[#f3ede2] md:hidden">
              {shown.map((o) => (
                <li key={o.id} className="flex flex-col gap-1 py-3">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] font-semibold">{o.code}</span>
                    <b className="text-success-700">{rupiah(o.net_profit)}</b>
                  </span>
                  <span className="text-xs text-ink-500">
                    {jktDateTime(o.confirmed_at)} · {one(o.accounts)?.account_code} · {one(o.vouchers)?.code} · {o.customer_name}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 text-xs">
                    <span>Jual {rupiah(o.sell_price)}</span>
                    <span>HPP {rupiah(Number(o.price_after_discount) + Number(o.allocated_cost))}</span>
                    {o.needs_review && <Pill tone="warning">Perlu tinjau</Pill>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Table head={['Waktu', 'ID order', 'Brand · akun', 'Voucher', 'Customer', 'Harga jual', 'HPP', 'Biaya', 'Laba bersih', 'Admin']}>
                {shown.map((o) => (
                  <tr key={o.id}>
                    <td className="whitespace-nowrap">{jktDateTime(o.confirmed_at)}</td>
                    <td className="whitespace-nowrap font-mono text-[13px] font-semibold">
                      {o.code}
                      {o.needs_review && <div><Pill tone="warning">Perlu tinjau</Pill></div>}
                    </td>
                    <td className="whitespace-nowrap">{brandOf(o)} · <span className="font-mono text-[13px]">{one(o.accounts)?.account_code}</span></td>
                    <td className="font-mono text-[13px]">{one(o.vouchers)?.code}</td>
                    <td>{o.customer_name}</td>
                    <td>{rupiah(o.sell_price)}</td>
                    <td>{rupiah(Number(o.price_after_discount) + Number(o.allocated_cost))}</td>
                    <td>{rupiah(o.extra_cost)}</td>
                    <td className="font-semibold">{rupiah(o.net_profit)}</td>
                    <td>{nameOf(o.admin_id)}</td>
                  </tr>
                ))}
              </Table>
            </div>
            {pages > 1 && (
              <nav aria-label="Halaman" className="flex items-center justify-between gap-2 text-sm">
                {pg > 1 ? <Link href={href({ page: pg - 1 })} scroll={false} className="btn-press rounded-lg border border-cream-300 bg-white px-3 py-2 font-semibold">← Sebelumnya</Link> : <span />}
                <span className="text-ink-500">Halaman {pg} dari {pages}</span>
                {pg < pages ? <Link href={href({ page: pg + 1 })} scroll={false} className="btn-press rounded-lg border border-cream-300 bg-white px-3 py-2 font-semibold">Berikutnya →</Link> : <span />}
              </nav>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
