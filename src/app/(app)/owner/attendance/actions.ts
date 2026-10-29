'use server'

import { randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { assertOwner } from '@/lib/auth'
import { callRpc, dbMessage, int, str, type ActionResult } from '@/lib/rpc'
import { createAdminClient, usernameToEmail } from '@/lib/supabase/server'
import { addDays, isYmd, jktDate, jktLocalToIso, weekStart } from '@/lib/format'

// Semua aksi di sini juga diperiksa ulang di database (require_owner / RLS insert khusus owner).
const P = ['/owner/attendance', '/attendance', '/approvals']
const uuid = z.string().uuid()
const kind = z.enum(['clock_in', 'break_start', 'break_end', 'clock_out'])

export async function generateWeek(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const week = str(fd, 'week')
  if (!isYmd(week)) return { ok: false, message: 'Periode tidak valid.' }
  const r = await callRpc('generate_regular_shifts', { p_week_start: week }, '', P)
  return r.ok ? { ok: true, message: `${r.data} shift reguler dibuat dari jadwal yang berlaku (yang sudah ada dilewati).` } : r
}

export async function flagIncomplete(): Promise<ActionResult> {
  const r = await callRpc('flag_incomplete_shifts', {}, '', P)
  return r.ok ? { ok: true, message: `${r.data} shift ditandai tidak lengkap.` } : r
}

export async function addExtraShift(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const admin = uuid.safeParse(str(fd, 'admin'))
  const start = jktLocalToIso(str(fd, 'start'))
  const end = jktLocalToIso(str(fd, 'end'))
  if (!admin.success || !start || !end) return { ok: false, message: 'Lengkapi staf, mulai, dan selesai.' }
  const r = await callRpc('add_extra_shift', { p_admin: admin.data, p_start: start, p_end: end }, '', P)
  return r.ok ? { ok: true, message: `Shift tambahan ${r.data} dibuat.` } : r
}

/** Koreksi owner = pengajuan + persetujuan langsung, sehingga nilai lama, baru, alasan, dan pelaku tercatat. */
export async function correctAttendance(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const shift = uuid.safeParse(str(fd, 'shift'))
  const k = kind.safeParse(str(fd, 'kind'))
  const at = jktLocalToIso(str(fd, 'at'))
  const reason = str(fd, 'reason')
  if (!shift.success || !k.success || !at) return { ok: false, message: 'Lengkapi bagian dan waktu.' }
  if (reason.length < 3) return { ok: false, message: 'Alasan koreksi wajib diisi.' }
  const req = await callRpc('request_attendance_fix', { p_shift: shift.data, p_kind: k.data, p_at: at, p_reason: reason }, '')
  if (!req.ok) return req
  return callRpc('decide_approval', { p_request: req.data, p_approve: true, p_note: 'Koreksi langsung oleh owner' }, 'Koreksi tersimpan dan uang saku dihitung ulang.', P)
}

export async function decideEarning(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'earning'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const approve = str(fd, 'decision') === 'approve'
  return callRpc('decide_earning', { p_earning: id.data, p_approve: approve, p_note: str(fd, 'note') || null },
    approve ? 'Disetujui.' : 'Ditolak.', P)
}

export async function buildPayrolls(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const week = str(fd, 'week')
  if (!isYmd(week)) return { ok: false, message: 'Periode tidak valid.' }
  const ids = fd.getAll('admin').map(String).filter((v) => uuid.safeParse(v).success)
  const errors: string[] = []
  for (const admin of ids) {
    const r = await callRpc('build_weekly_payroll', { p_admin: admin, p_period_start: week }, '')
    if (!r.ok) errors.push(r.message)
  }
  P.forEach((p) => revalidatePath(p))
  return errors.length
    ? { ok: false, message: `${ids.length - errors.length} rekap diperbarui. Sebagian dilewati: ${[...new Set(errors)].join(' ')}` }
    : { ok: true, message: `${ids.length} rekap diperbarui dari uang saku & bonus yang sudah disetujui.` }
}

export async function approvePayroll(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'payroll'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const amount = int(fd, 'adj_amount')
  const reason = str(fd, 'adj_reason')
  if (amount !== null && amount !== 0 && reason.length < 3) return { ok: false, message: 'Koreksi nominal wajib disertai alasan.' }
  const adjustments = amount ? [{ amount, reason }] : []
  return callRpc('approve_weekly_payroll', { p_payroll: id.data, p_adjustments: adjustments }, 'Rekap disetujui dan dikunci.', P)
}

export async function markPaid(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'payroll'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const r = await callRpc('mark_payroll_paid', { p_payroll: id.data, p_note: str(fd, 'note') || null }, '', P)
  return r.ok ? { ok: true, message: `Pencairan ${r.data} tercatat.` } : r
}

export async function setSchedule(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const admin = uuid.safeParse(str(fd, 'admin'))
  const days = fd.getAll('weekday').map(Number).filter((d) => d >= 1 && d <= 7)
  const from = str(fd, 'from')
  const start = str(fd, 'start')
  const end = str(fd, 'end')
  if (!admin.success || !isYmd(from) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end))
    return { ok: false, message: 'Lengkapi staf, hari, jam, dan tanggal berlaku.' }
  const saved = await callRpc('set_schedule', {
    p_admin: admin.data, p_weekdays: days, p_start: start, p_end: end,
    p_break: int(fd, 'break') ?? 60, p_effective_from: from, p_note: str(fd, 'note'),
  }, '', P)
  if (!saved.ok) return saved
  // Shift dibuat dari jadwal lewat generate_regular_shifts (sama dengan tombol "Buat shift reguler minggu ini").
  // Hanya menambah shift yang belum ada (unik per staf & jam mulai), jadi aman diulang; shift lama tidak berubah.
  const thisWeek = weekStart(jktDate())
  let created = 0
  for (const w of [thisWeek, addDays(thisWeek, 7)]) {
    const g = await callRpc('generate_regular_shifts', { p_week_start: w }, '', P)
    if (!g.ok) return { ok: true, message: `Jadwal baru tersimpan, tetapi shift belum dibuat: ${g.message} Tekan "Buat shift reguler minggu ini" di tab Absensi.` }
    created += Number(g.data ?? 0)
  }
  return { ok: true, message: `Jadwal baru tersimpan (versi lama tetap di histori). ${created} shift reguler dibuat untuk minggu ini & minggu depan; yang sudah ada dilewati.` }
}

export async function addBonusRule(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const supabase = await assertOwner().catch(() => null)
  if (!supabase) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const method = z.enum(['fixed_per_shift', 'per_net_hour', 'per_shift_type']).safeParse(str(fd, 'method'))
  const from = str(fd, 'from')
  if (!method.success || !isYmd(from)) return { ok: false, message: 'Pilih metode dan tanggal berlaku.' }
  const row = {
    method: method.data,
    fixed_rp: method.data === 'fixed_per_shift' ? int(fd, 'fixed_rp') : null,
    per_hour_rp: method.data === 'per_net_hour' ? int(fd, 'per_hour_rp') : null,
    day_per_hour_rp: method.data === 'per_shift_type' ? int(fd, 'day_per_hour_rp') : null,
    night_per_hour_rp: method.data === 'per_shift_type' ? int(fd, 'night_per_hour_rp') : null,
    effective_from: `${from}T00:00:00+07:00`,
  }
  // Tabel aturan hanya bisa ditambah (RLS: insert khusus owner). Versi lama tetap dipakai shift sebelumnya.
  const { error } = await supabase.from('bonus_rules').insert(row)
  if (error) return { ok: false, message: error.code === '23514' ? 'Isi tarif untuk metode yang dipilih.' : error.code === '23505' ? 'Sudah ada versi aturan di tanggal itu.' : dbMessage(error) }
  P.forEach((p) => revalidatePath(p))
  return { ok: true, message: 'Versi aturan bonus baru tersimpan.' }
}

export async function setStaffActive(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'profile'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const active = str(fd, 'active') === 'true'
  return callRpc('set_staff_active', { p_profile: id.data, p_active: active }, active ? 'Akun diaktifkan.' : 'Akun dinonaktifkan dan sesinya dicabut.', P)
}

export async function setStaffPermission(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'profile'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const can = str(fd, 'can') === 'true'
  return callRpc('set_staff_permission', { p_profile: id.data, p_can_restock: can }, can ? 'Izin restock Panel diberikan.' : 'Izin restock Panel dicabut.', P)
}

function tempPassword() {
  // 16 karakter acak; hanya ditampilkan sekali ke owner dan wajib diganti saat login pertama.
  return 'Tmp-' + randomBytes(9).toString('base64url')
}

export async function createStaff(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await assertOwner().catch(() => null)
  if (!owner) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const { data: me } = await owner.auth.getUser()
  const username = str(fd, 'username').toLowerCase()
  const fullName = str(fd, 'full_name')
  if (!/^[a-z0-9_.]{3,32}$/.test(username)) return { ok: false, message: 'Username 3–32 karakter: huruf kecil, angka, titik, garis bawah.' }
  if (fullName.length < 2) return { ok: false, message: 'Isi nama staf.' }
  const admin = createAdminClient()
  const { data: exists } = await admin.from('profiles').select('id').eq('username', username).maybeSingle()
  if (exists) return { ok: false, message: 'Username sudah dipakai.' }
  const password = tempPassword()
  const { data, error } = await admin.auth.admin.createUser({
    email: usernameToEmail(username),
    password,
    email_confirm: true,
    user_metadata: { username },
  })
  if (error || !data.user) return { ok: false, message: 'Gagal membuat akun. Coba username lain.' }
  // Peran selalu staf; owner tidak bisa dibuat dari aplikasi.
  const { error: pErr } = await admin.from('profiles').insert({
    id: data.user.id, username, full_name: fullName, role: 'staff', must_change_password: true,
  })
  if (pErr) {
    await admin.auth.admin.deleteUser(data.user.id)
    return { ok: false, message: 'Gagal menyimpan profil staf.' }
  }
  // Simpan hash password sementara agar penggantian password bisa dibuktikan (lihat mark_password_changed).
  await admin.rpc('_record_temp_password', { p_profile: data.user.id })
  await admin.from('audit_log').insert({
    actor_id: me.user?.id, action: 'staff.create', entity: 'profiles', entity_id: data.user.id, after: { username, full_name: fullName },
  })
  P.forEach((p) => revalidatePath(p))
  return { ok: true, message: `Akun ${username} dibuat. Password sementara (tampil sekali): ${password}` }
}

export async function resetPassword(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const supabase = await assertOwner().catch(() => null)
  if (!supabase) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const id = uuid.safeParse(str(fd, 'profile'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const { data: target } = await supabase.from('profiles').select('username, role').eq('id', id.data).single()
  if (!target || target.role !== 'staff') return { ok: false, message: 'Reset hanya untuk akun staf.' }
  const password = tempPassword()
  const { error } = await createAdminClient().auth.admin.updateUserById(id.data, { password })
  if (error) return { ok: false, message: 'Gagal mengganti password.' }
  // Cabut sesi lama + wajib ganti password (dan tercatat di audit log oleh fungsi database).
  const r = await callRpc('revoke_sessions', { p_profile: id.data }, '', P)
  if (!r.ok) return r
  return { ok: true, message: `Password ${target.username} direset. Password sementara (tampil sekali): ${password}` }
}

export async function verifyBenefit(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'claim'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const approve = str(fd, 'decision') === 'approve'
  const note = str(fd, 'note')
  if (!approve && note.length < 3) return { ok: false, message: 'Tulis alasan penolakan.' }
  // Server memastikan owner, status masih menunggu (dikunci), dan bukti sudah dibuka sebelum disetujui.
  return callRpc('verify_benefit_claim', { p_claim: id.data, p_approve: approve, p_note: note || null },
    approve ? 'Klaim terverifikasi: benefit ditandai sudah diambil.' : 'Klaim ditolak. Admin dapat melihat alasan dan mengajukan ulang.', P)
}
