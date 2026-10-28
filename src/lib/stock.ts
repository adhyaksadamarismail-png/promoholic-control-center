import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { currentVersion, ruleLabel, type Rule, type VoucherStatus } from '@/lib/inventory'

export type TypeSummary = {
  id: string
  brand_id: string
  code: string
  name: string
  grp: 'main' | 'extra'
  total: number
  used: number
  reserved: number
  expired: number
  broken: number
  available: number
  rule: string
  configured: boolean
}

/**
 * Rekap stok per jenis voucher dari voucher yang tercatat di aplikasi ini.
 * Bukan sinkronisasi dari aplikasi brand: angka hanya berubah lewat restock, order, dan koreksi yang disetujui.
 */
export async function loadTypeSummary(supabase: SupabaseClient, brand?: string) {
  let vq = supabase.from('vouchers').select('voucher_type_id, status')
  let tq = supabase.from('voucher_types').select('id, brand_id, code, name, grp, sort_order').order('sort_order')
  if (brand) {
    tq = tq.eq('brand_id', brand)
    vq = vq.like('code', `V-${brand}%`)
  }
  const [{ data: types }, { data: vouchers }, { data: versions }] = await Promise.all([
    tq,
    vq,
    supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
  ])
  const vers = (versions ?? []) as (Rule & { voucher_type_id: string; effective_from: string })[]
  return (types ?? []).map((t): TypeSummary => {
    const vs = (vouchers ?? []).filter((v) => v.voucher_type_id === t.id) as { status: VoucherStatus }[]
    const n = (s: VoucherStatus) => vs.filter((v) => v.status === s).length
    const r = currentVersion(vers, t.id)
    const configured = !!r && (r.fixed_discount !== null || (r.discount_pct !== null && r.max_discount !== null))
    return {
      id: t.id, brand_id: t.brand_id, code: t.code, name: t.name, grp: t.grp,
      total: vs.length, used: n('used'), reserved: n('reserved'), expired: n('expired'), broken: n('broken'), available: n('available'),
      rule: ruleLabel(r), configured,
    }
  })
}
