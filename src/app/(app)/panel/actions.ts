'use server'

import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
import { isYmd, jktDate } from '@/lib/format'
import { accountCodeError, normalizeAccountCode } from '@/lib/inventory'

const PATHS = ['/panel', '/stock', '/accounts', '/orders/new']
const uuid = z.string().uuid()

/** Jumlah per jenis dari form: field qty_<KODE>. Hanya angka 0–20; jenis otomatis diabaikan server. */
function quantities(fd: FormData) {
  const out: Record<string, number> = {}
  for (const [k, v] of fd.entries()) {
    const m = /^qty_([A-Z0-9]{1,8})$/.exec(k)
    const n = Number(v)
    if (m && Number.isInteger(n) && n > 0 && n <= 20) out[m[1]] = n
  }
  return out
}

// Izin restock Panel diperiksa ulang di database (can_restock_panel); akun selalu bersumber Panel.
export async function panelAddAccount(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const brand = str(fd, 'brand')
  const code = normalizeAccountCode(str(fd, 'code'))
  const until = str(fd, 'active_until')
  const idem = uuid.safeParse(str(fd, 'idem'))
  if (!/^[A-Z]{2}$/.test(brand)) return { ok: false, message: 'Pilih brand.' }
  const invalid = accountCodeError(code)
  if (invalid) return { ok: false, message: invalid }
  if (until && !isYmd(until)) return { ok: false, message: 'Tanggal masa aktif tidak valid.' }
  if (!idem.success) return { ok: false, message: 'Muat ulang halaman lalu coba lagi.' }
  const r = await callRpc('panel_add_account', {
    p_brand: brand, p_code: code, p_identity: str(fd, 'identity') || null, p_active_until: until || null,
    p_manual: quantities(fd), p_idem: idem.data,
  }, '', PATHS)
  return r.ok ? { ok: true, message: `${r.data} tercatat. Akun ${code} dan vouchernya sudah masuk stok.`, data: r.data } : r
}

export async function panelAddStock(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const account = uuid.safeParse(str(fd, 'account'))
  const idem = uuid.safeParse(str(fd, 'idem'))
  if (!account.success) return { ok: false, message: 'Pilih akun.' }
  if (!idem.success) return { ok: false, message: 'Muat ulang halaman lalu coba lagi.' }
  const items = Object.entries(quantities(fd)).map(([type, qty]) => ({ type, qty }))
  if (!items.length) return { ok: false, message: 'Isi jumlah minimal satu jenis voucher.' }
  const r = await callRpc('add_stock', { p_account: account.data, p_items: items, p_idem: idem.data }, '', PATHS)
  return r.ok ? { ok: true, message: `${r.data} tercatat. Voucher baru sudah masuk stok.`, data: r.data } : r
}

/** Restock Baperan: satu nomor telepon = satu akun Baperan dengan tepat 1 voucher. Aturan lengkap di database. */
export async function panelRestockBaperan(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const idem = uuid.safeParse(str(fd, 'idem'))
  const phone = str(fd, 'phone').replace(/\D/g, '').replace(/^62/, '0')
  const pin = str(fd, 'pin')
  const costRaw = str(fd, 'unit_cost').replace(/[^\d]/g, '')
  const date = str(fd, 'received_on')
  const until = str(fd, 'active_until')
  const source = str(fd, 'source_note')
  if (!idem.success) return { ok: false, message: 'Muat ulang halaman lalu coba lagi.' }
  if (!/^08\d{8,11}$/.test(phone)) return { ok: false, message: 'Nomor telepon tidak valid (diawali 08, 10–13 digit).' }
  if (pin && !/^\d{4,8}$/.test(pin)) return { ok: false, message: 'PIN harus 4–8 angka.' }
  if (!isYmd(date) || date > jktDate()) return { ok: false, message: 'Tanggal restock tidak valid.' }
  if (!isYmd(until)) return { ok: false, message: 'Isi tanggal berakhir masa aktif.' }
  if (until < date) return { ok: false, message: 'Masa aktif tidak boleh berakhir sebelum tanggal restock.' }
  if (source.length < 3) return { ok: false, message: 'Isi sumber pembelian / penerimaan.' }
  const r = await callRpc('restock_baperan', {
    p_phone: phone, p_pin: pin || null,
    // Kosong = modal belum diisi (bukan Rp0). Rp0 hanya bila memang gratis.
    p_unit_cost: costRaw === '' ? null : Number(costRaw),
    p_received_on: date, p_active_until: until, p_source_note: source, p_idem: idem.data,
  }, '', PATHS)
  return r.ok ? { ok: true, message: 'Akun Baperan tercatat.', data: r.data } : r
}
