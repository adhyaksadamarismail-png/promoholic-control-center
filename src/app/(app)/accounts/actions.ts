'use server'

import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
import { isYmd } from '@/lib/format'

export type BulkAccountResult = { done: number; skipped: number; results: { id: string; code: string | null; ok: boolean; reason?: string }[] }

const ids = z.array(z.string().uuid()).min(1).max(200)
const PATHS = ['/accounts', '/stock', '/panel', '/vm', '/orders/new', '/']

/** Owner: arsipkan satu/banyak akun (soft delete). Transaksi, voucher, dan laporan tidak disentuh; aturan & audit di archive_accounts. */
export async function archiveAccounts(accounts: string[], note: string): Promise<ActionResult> {
  const p = ids.safeParse(accounts)
  if (!p.success) return { ok: false, message: 'Pilih 1–200 akun.' }
  return callRpc('archive_accounts', { p_accounts: p.data, p_note: note.trim() || null }, 'Selesai.', PATHS)
}

/** Owner: pulihkan akun arsip; voucher, status, dan histori kembali apa adanya. */
export async function restoreAccounts(accounts: string[]): Promise<ActionResult> {
  const p = ids.safeParse(accounts)
  if (!p.success) return { ok: false, message: 'Pilih 1–200 akun.' }
  return callRpc('restore_accounts', { p_accounts: p.data }, 'Selesai.', PATHS)
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
