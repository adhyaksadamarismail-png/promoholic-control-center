import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { accountState, type AccountState, type VoucherStatus } from '@/lib/inventory'
import { baperanStatus } from '@/lib/baperan'
import { jktDate } from '@/lib/format'

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
  inventory: 'regular' | 'baperan'
  pin: string | null // hanya terisi untuk owner (view account_list)
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

  // Akun Baperan adalah inventaris terpisah (tab Baperan), tidak dicampur dengan akun reguler.
  const all = ((accounts ?? []) as AccountRow[]).map((a) => {
    const vs = (byAccount.get(a.id) ?? []).sort(
      (x, y) => (typeList.find((t) => t.id === x.voucher_type_id)?.sort_order ?? 0) - (typeList.find((t) => t.id === y.voucher_type_id)?.sort_order ?? 0) || x.slot - y.slot,
    )
    return { ...a, vouchers: vs, state: accountState(a.needs_review, vs.map((v) => v.status)) as AccountState }
  })
  const rows = all.filter((a) => a.inventory !== 'baperan')

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

export type BaperanFilter = { q?: string; bstatus?: string }

/** Inventaris Baperan: satu akun = satu identitas = 1 voucher. Tanggal restock & modal dari restock pembuatnya. */
export async function loadBaperan(supabase: SupabaseClient, f: BaperanFilter) {
  const { data: accounts } = await supabase
    .from('account_list')
    .select('id, account_code, account_number, pin, entered_at, active_until')
    .eq('inventory', 'baperan')
    .order('active_until', { ascending: true })
  const ids = (accounts ?? []).map((a) => a.id)
  const [{ data: vouchers }, { data: restocks }] = await Promise.all([
    ids.length ? supabase.from('vouchers').select('id, code, account_id, status, allocated_cost').in('account_id', ids) : Promise.resolve({ data: [] }),
    ids.length ? supabase.from('restocks').select('account_id, code, received_on, unit_cost, source_note').in('account_id', ids) : Promise.resolve({ data: [] }),
  ])
  const today = jktDate()
  const rows = (accounts ?? []).map((a) => ({
    ...(a as { id: string; account_code: string; account_number: string | null; pin: string | null; entered_at: string; active_until: string }),
    voucher: (vouchers ?? []).find((v) => v.account_id === a.id) as { id: string; code: string; status: VoucherStatus; allocated_cost: number | string | null } | undefined,
    restock: (restocks ?? []).find((r) => r.account_id === a.id) as { code: string; received_on: string | null; unit_cost: number | string | null; source_note: string | null } | undefined,
    status: baperanStatus(a.active_until, today),
  }))
  const q = f.q?.replace(/[^0-9a-z-]/gi, '').toLowerCase()
  const filtered = rows.filter(
    (r) =>
      (!q || r.account_number?.includes(q.replace(/^62/, '0').replace(/-/g, '')) || r.account_code.toLowerCase().includes(q) || (r.voucher?.code ?? '').toLowerCase().includes(q)) &&
      (!f.bstatus || r.status === f.bstatus),
  )
  return { rows, filtered, today }
}
