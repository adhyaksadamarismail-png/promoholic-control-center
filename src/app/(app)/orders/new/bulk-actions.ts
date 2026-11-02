'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createSessionClient } from '@/lib/supabase/server'
import { callRpc, dbMessage, type ActionResult } from '@/lib/rpc'
import { currentVersion, orderEstimate, ruleLabel, type Rule } from '@/lib/inventory'
import { baperanStatus } from '@/lib/baperan'
import { jktDate } from '@/lib/format'
import type { BulkOrderInput } from '@/lib/bulk-order'

const MAX = 100
export type BulkOrderChecked = {
  key: string; ok: boolean; errors: string[]; reasons: string[]
  brandName: string | null; accountCode: string | null; voucherId: string | null; voucherCode: string | null; ruleText: string | null
  discount: number | null; after: number | null; cost: number; costUnknown: boolean; hpp: number | null; gross: number | null; net: number | null
}
export type BulkOrderSaved = { key: string; ok: boolean; code?: string; error?: string; sell?: number; net?: number }

const WA = /^(\+62|62|0)8[0-9]{8,11}$/

/**
 * Validasi tanpa menyimpan, dari data terbaru. Tiap baris dihitung sendiri dengan rumus yang sama dengan transaksi satuan;
 * voucher dipilih per jenis dan tidak dipakai dua baris. record_order tetap memvalidasi ulang saat disimpan.
 */
export async function previewBulkOrders(rows: BulkOrderInput[]): Promise<ActionResult> {
  if (!rows.length) return { ok: false, message: 'Isi minimal satu baris.' }
  if (rows.length > MAX) return { ok: false, message: `Maksimal ${MAX} baris per batch.` }
  const supabase = await createSessionClient()
  const [{ data: brands }, { data: accounts }, { data: vouchers }, { data: types }, { data: versions }] = await Promise.all([
    supabase.from('brands').select('id, name'),
    supabase.from('account_list').select('*'),
    supabase.from('vouchers').select('id, code, account_id, voucher_type_id, allocated_cost').eq('status', 'available').order('code'),
    supabase.from('voucher_types').select('id, brand_id, code, name').eq('is_active', true),
    supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
  ])
  const vers = (versions ?? []) as (Rule & { voucher_type_id: string; effective_from: string })[]
  const today = jktDate()
  const taken = new Set<string>()

  const out = rows.map((r): BulkOrderChecked => {
    const errors: string[] = []
    const brandQ = r.brand.trim().toLowerCase()
    const brand = (brands ?? []).find((b) => b.id.toLowerCase() === brandQ || b.name.toLowerCase() === brandQ)
    if (!brand) errors.push(r.brand.trim() ? `Brand "${r.brand}" tidak dikenal` : 'Pilih brand')

    const code = r.account.trim().toUpperCase()
    const digits = code.replace(/\D/g, '')
    const account = brand && code
      ? (accounts ?? []).find((a) => a.brand_id === brand.id && (a.account_code === code || a.account_code === `${brand.id}-${code}` || `${brand.id}-${a.account_code}` === code || (a.inventory === 'baperan' && digits.length > 8 && a.account_number === digits)))
      : undefined
    if (!code) errors.push('Isi ID akun')
    else if (brand && !account) errors.push(`Akun ${code} tidak ditemukan di ${brand.name}`)
    else if (account?.archived_at) errors.push(`Akun ${account.account_code} diarsipkan`)
    else if (account?.inventory === 'baperan' && baperanStatus(account.active_until, today) === 'kedaluwarsa') errors.push(`Akun Baperan ${account.account_code} sudah kedaluwarsa`)

    const vq = r.voucher.trim().toUpperCase().replace(/^BAPERAN$/, 'BP')
    const type = brand ? (types ?? []).find((t) => t.brand_id === brand.id && t.code === vq) : undefined
    const pool = (vouchers ?? []).filter((v) => v.account_id === account?.id && !taken.has(v.id))
    const voucher = pool.find((v) => v.code === vq || v.voucher_type_id === type?.id)
    if (!vq) errors.push('Pilih voucher')
    else if (account && !voucher) errors.push(`Voucher ${vq} tidak tersedia di akun ${account.account_code} (sudah dipakai, dipesan, atau bukan jenis brand ini)`)
    if (voucher) taken.add(voucher.id)

    if (!r.name.trim()) errors.push('Isi nama customer')
    if (!WA.test(r.wa.replace(/[\s-]/g, ''))) errors.push('Nomor WhatsApp tidak valid')
    if (!r.menu) errors.push('Isi harga asli menu')
    if (r.sell === null) errors.push('Isi harga jual')

    const rule = voucher ? currentVersion(vers, voucher.voucher_type_id) ?? null : null
    const est = orderEstimate({ menu: r.menu, sell: r.sell, extra: r.extra, manual: r.manual, override: r.override, rule, cost: voucher ? voucher.allocated_cost : 0 })
    if (voucher && r.menu) {
      if (est.error) errors.push(est.error)
      else if (est.manualNeeded && est.discount === null) errors.push('Ketentuan voucher belum lengkap: isi potongan manual')
    }
    const reasons = [...est.reasons, ...(est.costUnknown ? ['Modal voucher belum diisi'] : [])]
    return {
      key: r.key, ok: !errors.length, errors, reasons,
      brandName: brand?.name ?? null, accountCode: account?.account_code ?? null, voucherId: voucher?.id ?? null, voucherCode: voucher?.code ?? null,
      ruleText: voucher ? ruleLabel(rule) : null,
      // Tanpa voucher tidak ada angka yang bisa dipercaya: jangan tampilkan laba seolah tanpa potongan.
      discount: voucher ? est.discount : null, after: voucher ? est.after : null, cost: est.cost, costUnknown: est.costUnknown,
      hpp: voucher ? est.hpp : null, gross: voucher ? est.gross : null, net: voucher ? est.net : null,
    }
  })
  return { ok: true, message: '', data: out }
}

const Save = z.array(z.object({
  key: z.string().uuid(), voucherId: z.string().uuid(), name: z.string().min(1), wa: z.string().min(8), ref: z.string(),
  menu: z.number().int().positive(), sell: z.number().int().min(0), extra: z.number().int().min(0).nullable(),
  manual: z.number().int().min(0).nullable(), override: z.number().int().min(0).nullable(),
})).min(1).max(MAX)

/**
 * Simpan lewat record_order, satu per satu: tiap baris punya ID transaksi sendiri dan gagal/berhasil sendiri.
 * `key` baris = kunci idempotensi, jadi kiriman ulang mengembalikan order yang sama, bukan transaksi ganda.
 */
export async function commitBulkOrders(input: z.input<typeof Save>): Promise<ActionResult> {
  const p = Save.safeParse(input)
  if (!p.success) return { ok: false, message: 'Data tidak valid. Ulangi validasi.' }
  const saved: BulkOrderSaved[] = []
  for (const r of p.data) {
    const res = await callRpc('record_order', {
      p_voucher: r.voucherId, p_customer_name: r.name, p_customer_wa: r.wa, p_ref: r.ref || null, p_menu_price: r.menu, p_sell_price: r.sell,
      p_extra_cost: r.extra ?? 0, p_manual_discount: r.manual, p_price_after_override: r.override, p_confirm: true, p_idem: r.key,
    }, '')
    saved.push(res.ok ? { key: r.key, ok: true, code: res.data as string } : { key: r.key, ok: false, error: res.message })
  }
  const codes = saved.flatMap((s) => (s.code ? [s.code] : []))
  if (codes.length) {
    const supabase = await createSessionClient()
    const { data, error } = await supabase.from('orders').select('code, sell_price, net_profit').in('code', codes)
    if (error) return { ok: false, message: dbMessage(error) }
    saved.forEach((s) => {
      const o = data?.find((x) => x.code === s.code)
      if (o) { s.sell = Number(o.sell_price); s.net = Number(o.net_profit) }
    })
  }
  ;['/orders/new', '/accounts', '/stock', '/finance', '/'].forEach((x) => revalidatePath(x))
  return { ok: true, message: '', data: saved }
}
