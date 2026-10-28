'use server'

import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
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

export async function claimBenefit(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const shift = z.string().uuid().safeParse(str(fd, 'shift'))
  if (!shift.success) return { ok: false, message: 'Permintaan tidak valid.' }
  return callRpc('claim_benefit', { p_shift: shift.data }, 'Benefit KopKen tercatat atas nama Anda.', PATHS)
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
