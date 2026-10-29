'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { assertOwner } from '@/lib/auth'
import { callRpc, dbMessage, int, str, type ActionResult } from '@/lib/rpc'
import { isYmd, jktDate } from '@/lib/format'

// Tabel keuangan & konfigurasi modal hanya bisa ditambah owner (RLS insert). Baris lama tidak diubah.
async function insert(table: string, row: Record<string, unknown>, success: string): Promise<ActionResult> {
  const supabase = await assertOwner().catch(() => null)
  if (!supabase) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const { error } = await supabase.from(table).insert(row)
  if (error) return { ok: false, message: error.code === '23505' ? 'Sudah ada versi dengan tanggal berlaku yang sama.' : dbMessage(error) }
  revalidatePath('/finance')
  return { ok: true, message: success }
}

export async function addExpense(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const date = str(fd, 'date')
  const amount = int(fd, 'amount')
  const category = str(fd, 'category')
  if (!isYmd(date) || !amount || amount <= 0 || category.length < 2) return { ok: false, message: 'Isi tanggal, kategori, dan nominal.' }
  return insert('expenses', { spent_on: date, category, amount_rp: amount, note: str(fd, 'note') || null }, 'Biaya operasional tercatat.')
}

export async function addPurchase(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const date = str(fd, 'date')
  const amount = int(fd, 'amount')
  const credits = Number(str(fd, 'credits').replace(',', '.'))
  if (!isYmd(date) || !amount || amount <= 0) return { ok: false, message: 'Isi tanggal dan nominal pembelian.' }
  return insert('inventory_purchases', {
    purchased_on: date, amount_rp: amount, credits: Number.isFinite(credits) && credits > 0 ? credits : null, note: str(fd, 'note') || null,
  }, 'Pembelian persediaan tercatat.')
}

export async function scheduleCreditPrice(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const price = int(fd, 'price')
  const from = str(fd, 'from')
  if (!price || price <= 0 || !isYmd(from)) return { ok: false, message: 'Isi harga per kredit dan tanggal berlaku.' }
  return insert('credit_prices', { rp_per_credit: price, effective_from: `${from}T00:00:00+07:00` },
    'Harga kredit baru dijadwalkan. Order lama tetap memakai harga saat dicatat.')
}

/** Versi modal baru per brand. Nilai hanya dari isian owner; validasi & audit diulang di set_brand_cost. */
export async function setBrandCost(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const brand = str(fd, 'brand')
  const basis = z.enum(['credit_per_account', 'rp_per_voucher', 'free']).safeParse(str(fd, 'basis'))
  const from = str(fd, 'from')
  if (!/^[A-Z]{2}$/.test(brand)) return { ok: false, message: 'Brand tidak valid.' }
  if (!basis.success) return { ok: false, message: 'Pilih metode biaya.' }
  if (!isYmd(from) || from < jktDate()) return { ok: false, message: 'Tanggal mulai berlaku tidak boleh di masa lalu.' }
  let credits: number | null = null
  let rp: number | null = null
  if (basis.data === 'credit_per_account') {
    credits = Number(str(fd, 'credits').replace(',', '.'))
    if (!Number.isFinite(credits) || credits <= 0 || credits >= 1000 || !/^\d+(\.\d{1,3})?$/.test(String(credits)))
      return { ok: false, message: 'Isi jumlah kredit per akun (lebih dari 0, maks. 3 angka desimal).' }
  } else if (basis.data === 'rp_per_voucher') {
    rp = int(fd, 'rp')
    if (!rp || rp <= 0) return { ok: false, message: 'Isi biaya per voucher dalam Rupiah (lebih dari 0).' }
  } else if (str(fd, 'confirm_free') !== 'on') {
    return { ok: false, message: 'Centang konfirmasi bahwa akun brand ini memang gratis.' }
  }
  const r = await callRpc('set_brand_cost', {
    p_brand: brand, p_basis: basis.data, p_credits: credits, p_rp: rp, p_effective_from: from, p_note: str(fd, 'note') || null,
  }, '', ['/finance', '/finance/brand-costs', '/panel', '/vm', '/settings/vouchers'])
  if (!r.ok) return r
  return { ok: true, message: from === jktDate() ? 'Modal brand tersimpan dan berlaku mulai hari ini.' : `Modal brand tersimpan, berlaku mulai ${from}.` }
}

export async function setAllocation(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const method = z.enum(['equal_main', 'weighted_max_discount']).safeParse(str(fd, 'method'))
  const from = str(fd, 'from')
  if (!method.success || !isYmd(from)) return { ok: false, message: 'Pilih metode dan tanggal berlaku.' }
  return insert('cost_allocation_settings', { method: method.data, extra_gets_cost: str(fd, 'extra') === 'on', effective_from: `${from}T00:00:00+07:00` },
    'Metode alokasi baru tersimpan untuk akun yang masuk setelah tanggal berlaku.')
}
