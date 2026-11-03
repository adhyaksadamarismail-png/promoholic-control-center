'use server'

import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
import { isYmd } from '@/lib/format'

export type BulkDeleteResult = { deleted: number; skipped: number; results: { id: string; code: string | null; ok: boolean; reason?: string; vouchers?: number }[] }

/** Owner: hapus banyak akun sekaligus. Per akun diproses terpisah di delete_accounts; akun bertransaksi dilewati beserta alasannya. */
export async function bulkDeleteAccounts(ids: string[]): Promise<ActionResult> {
  const p = z.array(z.string().uuid()).min(1).max(200).safeParse(ids)
  if (!p.success) return { ok: false, message: 'Pilih 1–200 akun.' }
  return callRpc('delete_accounts', { p_accounts: p.data }, 'Selesai.', ['/accounts', '/stock', '/panel', '/vm'])
}

/** Owner: perbarui masa aktif / PIN akun Baperan. Wajib beralasan; diperiksa & diaudit di database. */
export async function updateBaperan(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = z.string().uuid().safeParse(str(fd, 'account'))
  const until = str(fd, 'active_until')
  const pin = str(fd, 'pin')
  const reason = str(fd, 'reason')
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  if (!isYmd(until)) return { ok: false, message: 'Isi tanggal berakhir masa aktif.' }
  if (pin && !/^\d{4,8}$/.test(pin)) return { ok: false, message: 'PIN harus 4–8 angka.' }
  if (reason.length < 3) return { ok: false, message: 'Isi alasan perubahan.' }
  return callRpc('owner_update_baperan', { p_account: id.data, p_active_until: until, p_pin: pin || null, p_reason: reason },
    'Perubahan tersimpan dan tercatat di audit.', ['/accounts', '/orders/new'])
}
