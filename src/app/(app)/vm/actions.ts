'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { callRpc, int, str, type ActionResult } from '@/lib/rpc'
import { isYmd } from '@/lib/format'
import { accountCodeError, normalizeAccountCode } from '@/lib/inventory'

// Semua fungsi VM memanggil require_owner() di database; staf ditolak walau memanggil action ini langsung.
const PATHS = ['/vm', '/stock', '/accounts', '/orders/new']
const uuid = z.string().uuid()

export async function addDevice(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const name = str(fd, 'name')
  if (name.length < 2) return { ok: false, message: 'Isi nama device.' }
  const r = await callRpc('vm_add_device', { p_name: name, p_note: str(fd, 'note') || null }, '', PATHS)
  return r.ok ? { ok: true, message: `Device ${r.data} ditambahkan.`, data: r.data } : r
}

export async function vmAddAccount(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const device = str(fd, 'device')
  const code = normalizeAccountCode(str(fd, 'code'))
  const number = str(fd, 'number').replace(/[^\d]/g, '')
  const until = str(fd, 'active_until')
  const idem = uuid.safeParse(str(fd, 'idem'))
  if (!/^VD-\d{2,4}$/.test(device)) return { ok: false, message: 'Pilih device.' }
  const invalid = accountCodeError(code)
  if (invalid) return { ok: false, message: invalid }
  if (!/^08\d{8,11}$/.test(number)) return { ok: false, message: 'Nomor akun harus diawali 08, 10–13 digit.' }
  if (until && !isYmd(until)) return { ok: false, message: 'Tanggal masa aktif tidak valid.' }
  if (!idem.success) return { ok: false, message: 'Muat ulang halaman lalu coba lagi.' }
  const bp = int(fd, 'qty_BP') ?? 0
  const r = await callRpc('vm_add_account', {
    p_device: device, p_code: code, p_number: number, p_active_until: until || null,
    p_manual: bp > 0 ? { BP: bp } : {}, p_idem: idem.data,
  }, '', PATHS)
  return r.ok ? { ok: true, message: `${r.data} tercatat. Akun ${code} masuk ke ${device} dengan voucher utama otomatis.`, data: r.data } : r
}

export async function vmUpdateAccount(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'account'))
  const number = str(fd, 'number').replace(/[^\d]/g, '')
  const device = str(fd, 'device')
  const until = str(fd, 'active_until')
  if (!id.success || !/^VD-\d{2,4}$/.test(device)) return { ok: false, message: 'Permintaan tidak valid.' }
  if (!/^08\d{8,11}$/.test(number)) return { ok: false, message: 'Nomor akun harus diawali 08, 10–13 digit.' }
  if (until && !isYmd(until)) return { ok: false, message: 'Tanggal masa aktif tidak valid.' }
  const r = await callRpc('vm_update_account', { p_account: id.data, p_number: number, p_device: device, p_active_until: until || null },
    'Data akun diperbarui. Voucher tidak dibuat ulang.', PATHS)
  // Tampilkan device tujuan agar akun yang dipindah tetap terlihat.
  if (r.ok && str(fd, 'from_device') !== device) redirect(`/vm?device=${device}`)
  return r
}
