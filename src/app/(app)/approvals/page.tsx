import { requireOwnerPage } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, inputCls } from '@/components/ui'
import { jktDateTime, rupiah } from '@/lib/format'
import { KIND_LABEL, type AttendanceKind } from '@/lib/attendance'
import { decide } from './actions'

export const dynamic = 'force-dynamic'

const KIND: Record<string, string> = {
  order_cancel: 'Pembatalan order',
  stock_adjust: 'Koreksi stok voucher',
  attendance_fix: 'Koreksi absensi',
  benefit_fix: 'Pembatalan klaim benefit',
}
const VOUCHER_STATUS: Record<string, string> = { available: 'Tersedia', expired: 'Kedaluwarsa', broken: 'Rusak', used: 'Terpakai', reserved: 'Dipesan' }

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
    supabase.from('orders').select('id, code, customer_name, sell_price, status, created_at').in('id', ids('order_cancel')),
    supabase.from('vouchers').select('id, code, status').in('id', ids('stock_adjust')),
    supabase.from('shifts').select('id, code, planned_start, planned_end').in('id', ids('attendance_fix')),
    supabase.from('benefit_claims').select('id, claimed_at, benefit_entitlements(shifts(code))').in('id', ids('benefit_fix')),
  ])
  const name = (id: string) => profiles?.find((p) => p.id === id)?.full_name ?? '—'

  function target(r: Req) {
    if (r.kind === 'order_cancel') {
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
                    Diajukan {name(r.requested_by)} · {jktDateTime(r.requested_at)} · Alasan: “{r.reason}”
                  </span>
                </div>
                <Pill tone="warning">Menunggu</Pill>
              </div>
              <ActionForm action={decide} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <input type="hidden" name="request" value={r.id} />
                <input name="note" placeholder="Catatan keputusan (opsional)" className={`${inputCls} flex-1`} />
                <SubmitButton name="decision" value="approve" variant="success">Setujui</SubmitButton>
                <SubmitButton name="decision" value="reject" variant="danger">Tolak</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
        <Note>
          Menyetujui tidak menghapus data lama: pembatalan order mengembalikan voucher lewat entri stok balik, koreksi absensi
          menambah event koreksi, dan pembatalan klaim menandai klaim lama sebagai dibatalkan. Semua tercatat di audit log.
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
                <Pill tone={r.status === 'approved' ? 'success' : 'danger'}>{r.status === 'approved' ? 'Disetujui' : 'Ditolak'}</Pill>
              </span>
            </li>
          ))}
          {!recent?.length && <li className="py-2.5 text-ink-500">Belum ada keputusan.</li>}
        </ul>
      </Card>
    </div>
  )
}
