'use server'

import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
import { createAdminClient, createSessionClient } from '@/lib/supabase/server'
import { jktLocalToIso } from '@/lib/format'
import { ACTION_LABEL, type AttendanceKind } from '@/lib/attendance'

const kind = z.enum(['clock_in', 'break_start', 'break_end', 'clock_out'])
const PATHS = ['/attendance', '/']

// Admin diambil dari sesi di dalam fungsi database; form hanya mengirim id shift dan jenis aksi.
export async function attendanceAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const k = kind.safeParse(str(fd, 'kind'))
  const shift = z.string().uuid().safeParse(str(fd, 'shift'))
  if (!k.success || !shift.success) return { ok: false, message: 'Permintaan tidak valid.' }
  return callRpc('attendance_action', { p_shift: shift.data, p_kind: k.data }, `${ACTION_LABEL[k.data as AttendanceKind]} tercatat (waktu server).`, PATHS)
}

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024

/** Jenis gambar ditentukan dari isi file (magic bytes), bukan dari nama atau MIME kiriman browser. */
function imageType(b: Uint8Array): { ext: string; mime: string } | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return { ext: 'png', mime: 'image/png' }
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}

/**
 * Ajukan pengambilan benefit: unggah receipt ke storage privat dengan sesi admin (RLS storage: hanya folder sendiri),
 * lalu submit_benefit_claim memeriksa hak dari data absensi. Status awal selalu "Menunggu Verifikasi".
 */
export async function submitBenefit(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const shift = z.string().uuid().safeParse(str(fd, 'shift'))
  const cup = z.enum(['regular', 'large']).safeParse(str(fd, 'cup_size'))
  const file = fd.get('receipt')
  if (!shift.success) return { ok: false, message: 'Permintaan tidak valid.' }
  if (!cup.success) return { ok: false, message: 'Pilih ukuran cup: Regular atau Large.' }
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Unggah foto atau screenshot receipt.' }
  if (file.size > MAX_RECEIPT_BYTES) return { ok: false, message: 'Ukuran gambar maksimal 5 MB.' }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = imageType(bytes)
  if (!type) return { ok: false, message: 'File harus gambar JPG, PNG, atau WebP.' }

  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return { ok: false, message: 'Sesi berakhir. Masuk lagi.' }
  const path = `${auth.user.id}/${shift.data}/${randomUUID()}.${type.ext}`
  const up = await supabase.storage.from('benefit-receipts').upload(path, bytes, { contentType: type.mime, upsert: false })
  if (up.error) return { ok: false, message: 'Gagal mengunggah receipt. Coba lagi.' }

  const r = await callRpc('submit_benefit_claim', { p_shift: shift.data, p_cup_size: cup.data, p_receipt_path: path },
    'Pengajuan terkirim. Status: Menunggu Verifikasi owner.', [...PATHS, '/owner/attendance'])
  // Pengajuan ditolak database: hapus gambar yang tidak terpakai (oleh server, setelah sesi pengunggah diverifikasi).
  if (!r.ok) await createAdminClient().storage.from('benefit-receipts').remove([path])
  return r
}

export async function requestAttendanceFix(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const k = kind.safeParse(str(fd, 'kind'))
  const shift = z.string().uuid().safeParse(str(fd, 'shift'))
  const at = jktLocalToIso(str(fd, 'at'))
  const reason = str(fd, 'reason')
  if (!k.success || !shift.success || !at) return { ok: false, message: 'Lengkapi jenis dan waktu yang benar.' }
  if (reason.length < 3) return { ok: false, message: 'Tulis alasan koreksi.' }
  return callRpc('request_attendance_fix', { p_shift: shift.data, p_kind: k.data, p_at: at, p_reason: reason },
    'Pengajuan koreksi terkirim ke owner.', PATHS)
}

export async function requestBenefitFix(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const claim = z.string().uuid().safeParse(str(fd, 'claim'))
  const reason = str(fd, 'reason')
  if (!claim.success) return { ok: false, message: 'Permintaan tidak valid.' }
  if (reason.length < 3) return { ok: false, message: 'Tulis alasan koreksi.' }
  return callRpc('request_benefit_fix', { p_claim: claim.data, p_reason: reason }, 'Pengajuan pembatalan klaim terkirim ke owner.', PATHS)
}
