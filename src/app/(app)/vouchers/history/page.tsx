import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase/server'
import { Card, PageHeader, Pill, Table, inputCls } from '@/components/ui'
import { addDays, dateLabel, isYmd, jktDate, jktDateTime } from '@/lib/format'
import { LEDGER_REASON, VOUCHER_STATUS, type VoucherStatus } from '@/lib/inventory'
import { loadHistory, type HistoryRow } from '@/lib/history'

export const dynamic = 'force-dynamic'

type SP = { from?: string; to?: string; brand?: string; event?: string; q?: string }

const TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger' | 'info'> = {
  restock: 'success', use: 'info', reserve: 'warning', release: 'neutral', reversal: 'warning', expire: 'danger', adjust: 'danger',
}

export default async function VoucherHistoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const today = jktDate()
  const to = isYmd(sp.to) ? sp.to : today
  const from = isYmd(sp.from) ? sp.from : addDays(to, -6)
  const supabase = await createSessionClient()
  const [{ data: brands }, { data: role }, rows] = await Promise.all([
    supabase.from('brands').select('id, name').order('name'),
    supabase.rpc('current_app_role'),
    loadHistory(supabase, { from, to, brand: sp.brand, event: sp.event, q: sp.q }),
  ])
  const qs = new URLSearchParams(Object.entries({ ...sp, from, to }).filter(([, v]) => v) as [string, string][]).toString()
  const status = (r: HistoryRow) => VOUCHER_STATUS[r.status as VoucherStatus]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow={`Log tidak dapat diubah atau dihapus · ${dateLabel(from)} – ${dateLabel(to)}`} title="Riwayat Pemakaian Voucher">
        <a href={`/vouchers/history/export?${qs}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Export CSV</a>
      </PageHeader>

      <form role="search" className="grid grid-cols-2 items-end gap-2 rounded-2xl border border-cream-300 bg-white p-4 md:flex md:flex-wrap">
        <label className="col-span-2 flex min-w-48 flex-1 flex-col gap-1.5 text-sm font-semibold">
          Cari
          <input name="q" defaultValue={sp.q} placeholder="ID voucher, akun, order, customer" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">Dari<input type="date" name="from" defaultValue={from} max={today} className={inputCls} /></label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">Sampai<input type="date" name="to" defaultValue={to} max={today} className={inputCls} /></label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Brand
          <select name="brand" defaultValue={sp.brand ?? ''} className={inputCls}>
            <option value="">Semua brand</option>
            {(brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Peristiwa
          <select name="event" defaultValue={sp.event ?? ''} className={inputCls}>
            <option value="">Semua peristiwa</option>
            {Object.entries(LEDGER_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Terapkan</button>
        <Link href="/vouchers/history" className="flex min-h-11 items-center px-2 text-sm font-semibold text-orange-700">Hapus filter</Link>
      </form>

      {/* HP: kartu per peristiwa. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className={`flex flex-col gap-1.5 rounded-xl border p-3.5 text-sm ${r.cancelChain ? 'border-warning-700/30 bg-warning-100/60' : 'border-cream-300 bg-white'}`}>
            <div className="flex items-center justify-between gap-2">
              <Pill tone={TONE[r.reason] ?? 'neutral'}>{LEDGER_REASON[r.reason] ?? r.reason}</Pill>
              <span className="text-xs text-ink-500">{jktDateTime(r.at)}</span>
            </div>
            <Link href={`/accounts/${r.accountId}`} className="inline-flex min-h-8 items-center font-mono text-[13px] font-semibold">{r.voucherCode}</Link>
            <span className="text-xs text-ink-500">{r.accountCode} · {r.typeName}</span>
            {(r.customer || r.orderCode) && (
              <span className="text-xs">
                {r.customer && <>{r.customer} · <span className="font-mono">{r.wa}</span></>}
                {r.orderCode && <span className="font-mono"> · {r.orderCode}</span>}
              </span>
            )}
            <span className="text-xs text-ink-500">
              Oleh {r.actor} · status {status(r)?.label ?? r.status}
              {r.note && ` · ${r.note}`}
            </span>
          </li>
        ))}
        {!rows.length && <li className="rounded-xl bg-white p-4 text-sm text-ink-500">Tidak ada peristiwa untuk filter ini.</li>}
      </ul>

      <div className="hidden md:block">
      <Card>
        <Table head={['Waktu', 'Peristiwa', 'Voucher', 'Akun · jenis', 'Customer', 'WhatsApp', 'Order', 'Pelaku', 'Status voucher', 'Alasan / catatan']} empty="Tidak ada peristiwa untuk filter ini.">
          {rows.map((r) => (
            <tr key={r.id} className={r.cancelChain ? 'bg-warning-100/50 [&>td:first-child]:!bg-[#fdf3e3]' : ''}>
              <td className="whitespace-nowrap">{jktDateTime(r.at)}</td>
              <td><Pill tone={TONE[r.reason] ?? 'neutral'}>{LEDGER_REASON[r.reason] ?? r.reason}</Pill></td>
              <td className="whitespace-nowrap font-mono text-[13px]"><Link href={`/accounts/${r.accountId}`}>{r.voucherCode}</Link></td>
              <td><span className="font-mono text-[13px]">{r.accountCode}</span><div className="text-xs text-ink-500">{r.typeName}</div></td>
              <td>{r.customer ?? '—'}</td>
              <td className="whitespace-nowrap font-mono text-[13px]">{r.wa ?? '—'}</td>
              <td className="whitespace-nowrap font-mono text-[13px]">{r.orderCode ?? r.ref ?? '—'}</td>
              <td>{r.actor}</td>
              <td>{status(r)?.label ?? r.status}</td>
              <td className="text-ink-500">{r.note ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>
      </div>
      <p className="text-xs text-ink-500">
        Baris berlatar krem = satu rangkaian pembatalan resmi. Pemakaian lama tetap tercatat; pembatalan menambah peristiwa baru, bukan menghapus.
        Maksimal 500 peristiwa per tampilan — persempit tanggal bila perlu.
        {role !== 'owner' && ' Nomor WhatsApp customer order admin lain disamarkan.'}
      </p>
    </div>
  )
}
