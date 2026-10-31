import { requireOwnerPage } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, inputCls } from '@/components/ui'
import { jktDateTime, rupiah } from '@/lib/format'
import { KIND_LABEL, type AttendanceKind } from '@/lib/attendance'
import { decide } from './actions'

export const dynamic = 'force-dynamic'

const KIND: Record<string, string> = {
  order_review: 'Tinjauan order',
  order_cancel: 'Pembatalan order',
  stock_adjust: 'Koreksi stok voucher',
  attendance_fix: 'Koreksi absensi',
  benefit_fix: 'Pembatalan klaim benefit',
}
const VOUCHER_STATUS: Record<string, string> = { available: 'Tersedia', expired: 'Kedaluwarsa', broken: 'Rusak', used: 'Terpakai', reserved: 'Dipesan' }

const DECISION: Record<string, { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
  approved: { label: 'Disetujui', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  closed: { label: 'Ditutup', tone: 'neutral' },
}

type Req = {
  id: string; kind: string; target_id: string; payload: Record<string, string>; reason: string; status: string
  requested_by: string; requested_at: string; decided_at: string | null; decision_note: string | null
}

export default async function ApprovalsPage() {
  const supabase = await requireOwnerPage()
  const [{ data: pending }, { data: recent }, { data: profiles }] = await Promise.all([
    supabase.from('approval_requests').select('*').eq('status', 'pending').order('requested_at'),
    supabase.from('approval_requests').select('*').neq('status', 'pending').order('decided_at', { ascending: false }).limit(15),
    supabase.from('profiles').select('id, full_name'),
  ])
  const all = [...(pending ?? []), ...(recent ?? [])] as Req[]
  const ids = (k: string) => all.filter((r) => r.kind === k).map((r) => r.target_id)

  // Detail target per jenis pengajuan, diambil sekali per jenis.
  const [{ data: orders }, { data: vouchers }, { data: shifts }, { data: claims }] = await Promise.all([
    supabase.from('orders')
      .select('id, code, admin_id, customer_name, menu_price, discount, price_after_discount, sell_price, net_profit, status, created_at, vouchers(code)')
      .in('id', [...ids('order_cancel'), ...ids('order_review')]),
    supabase.from('vouchers').select('id, code, status').in('id', ids('stock_adjust')),
    supabase.from('shifts').select('id, code, planned_start, planned_end').in('id', ids('attendance_fix')),
    supabase.from('benefit_claims').select('id, claimed_at, benefit_entitlements(shifts(code))').in('id', ids('benefit_fix')),
  ])
  const name = (id: string) => profiles?.find((p) => p.id === id)?.full_name ?? '—'

  function target(r: Req) {
    if (r.kind === 'order_cancel' || r.kind === 'order_review') {
      const o = orders?.find((x) => x.id === r.target_id)
      return o ? `${o.code} · ${o.customer_name} · ${rupiah(o.sell_price)} · dibuat ${jktDateTime(o.created_at)}` : 'Order'
    }
    if (r.kind === 'stock_adjust') {
      const v = vouchers?.find((x) => x.id === r.target_id)
      return `${v?.code ?? 'Voucher'}: ${VOUCHER_STATUS[v?.status ?? ''] ?? v?.status} → ${VOUCHER_STATUS[r.payload.new_status] ?? r.payload.new_status}`
    }
    if (r.kind === 'attendance_fix') {
      const s = shifts?.find((x) => x.id === r.target_id)
      return `${s?.code ?? 'Shift'} · ${KIND_LABEL[r.payload.kind as AttendanceKind] ?? r.payload.kind} menjadi ${jktDateTime(r.payload.at)}`
    }
    const c = claims?.find((x) => x.id === r.target_id) as { claimed_at: string; benefit_entitlements: { shifts: { code: string } } } | undefined
    return `Klaim ${c?.benefit_entitlements?.shifts?.code ?? ''} · ${jktDateTime(c?.claimed_at)}`
  }

  /** Rincian transaksi yang ditinjau: harga hitungan voucher dibandingkan dengan yang dicatat. */
  function orderDetail(id: string) {
    const o = orders?.find((x) => x.id === id)
    if (!o) return null
    const v = (Array.isArray(o.vouchers) ? o.vouchers[0] : o.vouchers) as { code: string } | null
    const expected = o.menu_price - o.discount
    const gap = o.price_after_discount - expected
    const rows: [string, string][] = [
      ['Dicatat oleh', name(o.admin_id)],
      ['Voucher', v?.code ?? '—'],
      ['Harga menu', rupiah(o.menu_price)],
      ['Potongan voucher', rupiah(o.discount)],
      ['Harga merchant (hitungan)', rupiah(expected)],
      ['Harga merchant (dicatat)', rupiah(o.price_after_discount)],
      ['Selisih', gap ? `${gap > 0 ? '+' : '−'}${rupiah(Math.abs(gap))}` : 'Tidak ada'],
      ['Harga jual', rupiah(o.sell_price)],
      ['Laba bersih', rupiah(o.net_profit)],
    ]
    return (
      <details className="rounded-lg bg-cream-50 px-3 py-2 text-sm">
        <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-orange-700">Lihat detail transaksi</summary>
        <dl className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {rows.map(([k, val]) => (
            <div key={k} className="flex justify-between gap-3 border-t border-[#f1eadc] py-1.5">
              <dt className="text-ink-500">{k}</dt>
              <dd className="text-right font-semibold">{val}</dd>
            </div>
          ))}
        </dl>
      </details>
    )
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader eyebrow="Hanya owner" title="Persetujuan" />

      <Card title={`Menunggu keputusan (${pending?.length ?? 0})`}>
        {!pending?.length && <p className="text-sm text-ink-500">Tidak ada pengajuan yang menunggu.</p>}
        <ul className="flex flex-col gap-3">
          {(pending as Req[] | null)?.map((r) => (
            <li key={r.id} className="flex flex-col gap-3 rounded-xl border border-cream-300 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <span className="font-semibold">{KIND[r.kind]}</span>
                  <span className="text-sm">{target(r)}</span>
                  <span className="text-sm text-ink-500">
                    {r.kind === 'order_review' ? 'Dicatat' : 'Diajukan'} {name(r.requested_by)} · {jktDateTime(r.requested_at)} · {r.kind === 'order_review' ? 'Ditandai sistem' : 'Alasan'}: “{r.reason}”
                  </span>
                </div>
                <Pill tone="warning">Menunggu</Pill>
              </div>
              {r.kind === 'order_review' && orderDetail(r.target_id)}
              <ActionForm action={decide} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <input type="hidden" name="request" value={r.id} />
                <input name="note" placeholder={r.kind === 'order_review' ? 'Catatan (wajib bila menolak)' : 'Catatan keputusan (opsional)'} aria-label="Catatan keputusan" className={`${inputCls} flex-1`} />
                <SubmitButton name="decision" value="approve" variant="success">Setujui</SubmitButton>
                <SubmitButton name="decision" value="reject" variant="danger">Tolak</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
        <Note>
          Menyetujui tidak menghapus data lama: pembatalan order mengembalikan voucher lewat entri stok balik, koreksi absensi
          menambah event koreksi, dan pembatalan klaim menandai klaim lama sebagai dibatalkan. Tinjauan order hanya mencatat keputusan:
          angka order, voucher, dan Keuangan tetap. Bila order yang ditolak harus dibatalkan, ajukan pembatalan dari Transaksi Order. Semua tercatat di audit log.
        </Note>
      </Card>

      <Card title="Keputusan terakhir">
        <ul className="flex flex-col divide-y divide-[#f1eadc] text-sm">
          {(recent as Req[] | null)?.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span>
                <b>{KIND[r.kind]}</b> · {target(r)} · {name(r.requested_by)}
                {r.decision_note && <span className="text-ink-500"> · {r.decision_note}</span>}
              </span>
              <span className="flex items-center gap-2 text-ink-500">
                {jktDateTime(r.decided_at)}
                <Pill tone={DECISION[r.status]?.tone ?? 'neutral'}>{DECISION[r.status]?.label ?? r.status}</Pill>
              </span>
            </li>
          ))}
          {!recent?.length && <li className="py-2.5 text-ink-500">Belum ada keputusan.</li>}
        </ul>
      </Card>
    </div>
  )
}
