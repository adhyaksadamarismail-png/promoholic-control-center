import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { accountState, type AccountState, type VoucherStatus } from '@/lib/inventory'

export type AccountRow = {
  id: string
  brand_id: string
  account_code: string
  source: 'vm' | 'panel'
  vm_device_id: string | null
  account_number: string | null
  entered_at: string
  active_until: string | null
  needs_review: boolean
  review_note: string | null
}
export type VoucherRow = { id: string; code: string; account_id: string; voucher_type_id: string; grp: 'main' | 'extra'; slot: number; status: VoucherStatus }
export type TypeRow = { id: string; brand_id: string; code: string; name: string; grp: 'main' | 'extra'; sort_order: number }

export type AccountFilter = { q?: string; brand?: string; source?: string; status?: string }

/** Data Daftar Akun. Akun dibaca dari view account_list (nomor disamarkan untuk staf, device hanya owner). */
export async function loadAccounts(supabase: SupabaseClient, f: AccountFilter) {
  const [{ data: brands }, { data: accounts }, { data: vouchers }, { data: types }, { data: versions }] = await Promise.all([
    supabase.from('brands').select('id, name').order('name'),
    supabase.from('account_list').select('*').order('entered_at', { ascending: false }),
    supabase.from('vouchers').select('id, code, account_id, voucher_type_id, grp, slot, status'),
    supabase.from('voucher_types').select('id, brand_id, code, name, grp, sort_order').order('sort_order'),
    supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, max_discount'),
  ])
  const byAccount = new Map<string, VoucherRow[]>()
  ;((vouchers ?? []) as VoucherRow[]).forEach((v) => byAccount.set(v.account_id, [...(byAccount.get(v.account_id) ?? []), v]))
  const typeList = (types ?? []) as TypeRow[]

  // Brand dengan jenis voucher yang ketentuannya belum lengkap (tanpa versi, atau diskon % tanpa batas maksimum).
  const incomplete = new Set(
    typeList
      .filter((t) => {
        const vs = (versions ?? []).filter((v) => v.voucher_type_id === t.id)
        return !vs.length || vs.some((v) => v.discount_pct === null && v.fixed_discount === null) || vs.some((v) => v.discount_pct !== null && v.max_discount === null)
      })
      .map((t) => t.brand_id),
  )

  const rows = ((accounts ?? []) as AccountRow[]).map((a) => {
    const vs = (byAccount.get(a.id) ?? []).sort(
      (x, y) => (typeList.find((t) => t.id === x.voucher_type_id)?.sort_order ?? 0) - (typeList.find((t) => t.id === y.voucher_type_id)?.sort_order ?? 0) || x.slot - y.slot,
    )
    return { ...a, vouchers: vs, state: accountState(a.needs_review, vs.map((v) => v.status)) as AccountState }
  })

  const q = f.q?.trim().toLowerCase()
  const filtered = rows.filter(
    (r) =>
      (!q || r.account_code.toLowerCase().includes(q) || (r.account_number ?? '').includes(q) || r.vouchers.some((v) => v.code.toLowerCase().includes(q))) &&
      (!f.brand || r.brand_id === f.brand) &&
      (!f.source || r.source === f.source) &&
      (!f.status || r.state === f.status),
  )
  return { brands: brands ?? [], types: typeList, rows, filtered, incomplete }
}
