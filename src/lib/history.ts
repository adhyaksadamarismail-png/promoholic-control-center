import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays } from '@/lib/format'

export type HistoryFilter = { from: string; to: string; brand?: string; event?: string; q?: string }

export type HistoryRow = {
  id: number
  at: string
  reason: string
  delta: number
  status: string
  ref: string | null
  voucherCode: string
  accountId: string
  accountCode: string
  typeName: string
  customer: string | null
  wa: string | null
  orderCode: string | null
  actor: string
  note: string | null
  cancelChain: boolean // bagian dari rangkaian pembatalan resmi (pemakaian yang dibatalkan + entri balik)
}

/**
 * Riwayat voucher dari stock_ledger (hanya-tambah). Data customer diambil dari view tersamar
 * voucher_usage_list, jadi staf melihat WhatsApp tersamar untuk order admin lain.
 */
export async function loadHistory(supabase: SupabaseClient, f: HistoryFilter): Promise<HistoryRow[]> {
  let lq = supabase
    .from('stock_ledger')
    .select('id, voucher_id, account_id, delta, reason, status_after, ref, actor_id, at')
    .gte('at', `${f.from}T00:00:00+07:00`)
    .lt('at', `${addDays(f.to, 1)}T00:00:00+07:00`)
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(500)
  if (f.event) lq = lq.eq('reason', f.event)
  const { data: ledger } = await lq
  const rows = ledger ?? []
  const vIds = [...new Set(rows.map((r) => r.voucher_id))]
  const aIds = [...new Set(rows.map((r) => r.account_id))]

  const [{ data: vouchers }, { data: accounts }, { data: types }, { data: usages }, { data: profiles }, { data: approvals }] = await Promise.all([
    supabase.from('vouchers').select('id, code, voucher_type_id').in('id', vIds),
    supabase.from('account_list').select('id, account_code, brand_id').in('id', aIds),
    supabase.from('voucher_types').select('id, name'),
    supabase.from('voucher_usage_list').select('voucher_id, order_id, order_code, customer_name, customer_wa, reversed_at').in('voucher_id', vIds),
    supabase.from('profiles').select('id, full_name'),
    // RLS: owner melihat semua alasan; staf hanya alasan pengajuannya sendiri.
    supabase.from('approval_requests').select('id, kind, target_id, reason, decision_note, status'),
  ])

  const out = rows.map((r): HistoryRow => {
    const v = vouchers?.find((x) => x.id === r.voucher_id)
    const a = accounts?.find((x) => x.id === r.account_id)
    const u = usages?.find((x) => x.voucher_id === r.voucher_id && x.order_code === r.ref)
    let note: string | null = null
    if (r.reason === 'reversal' && u) note = approvals?.find((x) => x.kind === 'order_cancel' && x.target_id === u.order_id && x.status === 'approved')?.reason ?? 'Pembatalan disetujui owner'
    if (r.reason === 'adjust') {
      const req = approvals?.find((x) => x.kind === 'stock_adjust' && r.ref === 'APR-' + x.id.slice(0, 8))
      note = req ? req.reason : 'Koreksi disetujui owner'
    }
    if (r.reason === 'release') note = 'Draft dibatalkan admin'
    return {
      id: r.id,
      at: r.at,
      reason: r.reason,
      delta: r.delta,
      status: r.status_after,
      ref: r.ref,
      voucherCode: v?.code ?? '—',
      accountId: r.account_id,
      accountCode: a?.account_code ?? '—',
      typeName: types?.find((t) => t.id === v?.voucher_type_id)?.name ?? '',
      customer: u?.customer_name ?? null,
      wa: u?.customer_wa ?? null,
      orderCode: r.reason === 'restock' || r.reason === 'adjust' ? null : r.ref,
      actor: profiles?.find((p) => p.id === r.actor_id)?.full_name ?? 'Sistem',
      note,
      cancelChain: !!u?.reversed_at && (r.reason === 'use' || r.reason === 'reversal'),
    }
  })

  const q = f.q?.trim().toLowerCase()
  return out.filter(
    (r) =>
      (!f.brand || r.accountCode.startsWith(f.brand + '-')) &&
      (!q || [r.voucherCode, r.accountCode, r.orderCode, r.customer, r.ref].some((x) => x?.toLowerCase().includes(q))),
  )
}
