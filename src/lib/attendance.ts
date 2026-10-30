export type AttendanceKind = 'clock_in' | 'break_start' | 'break_end' | 'clock_out' | 'off_start' | 'off_end'
export type AttendanceEvent = { id: number; kind: AttendanceKind; at: string; corrects_id: number | null; correction_reason: string | null; actor_id?: string }

export const KIND_LABEL: Record<AttendanceKind, string> = {
  clock_in: 'Masuk',
  break_start: 'Mulai istirahat',
  break_end: 'Selesai istirahat',
  clock_out: 'Pulang',
  off_start: 'Mulai Off/Izin',
  off_end: 'Selesai Off/Izin',
}

export const ACTION_LABEL: Record<AttendanceKind, string> = {
  clock_in: 'Absen masuk',
  break_start: 'Mulai istirahat',
  break_end: 'Selesai istirahat',
  clock_out: 'Absen pulang',
  off_start: 'Mulai Off/Izin',
  off_end: 'Selesai Off/Izin',
}

/** Status kerja dari event terakhir (sama dengan owner_set_work_status di database). */
export type WorkStatus = 'belum' | 'masuk' | 'istirahat' | 'off' | 'selesai'
export const WORK_STATUS: Record<WorkStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  belum: { label: 'Belum masuk', tone: 'neutral' },
  masuk: { label: 'Masuk / Aktif', tone: 'success' },
  istirahat: { label: 'Istirahat', tone: 'warning' },
  off: { label: 'Off / Izin', tone: 'danger' },
  selesai: { label: 'Selesai', tone: 'info' },
}
export function workStatus(effective: AttendanceEvent[]): { status: WorkStatus; since: string | null } {
  const last = effective.at(-1)
  if (!last) return { status: 'belum', since: null }
  const status: WorkStatus =
    last.kind === 'break_start' ? 'istirahat' : last.kind === 'off_start' ? 'off' : last.kind === 'clock_out' ? 'selesai' : 'masuk'
  return { status, since: last.at }
}

export const SHIFT_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  scheduled: { label: 'Belum absen', tone: 'neutral' },
  in_progress: { label: 'Sedang bekerja', tone: 'info' },
  completed: { label: 'Selesai', tone: 'success' },
  incomplete: { label: 'Tidak lengkap', tone: 'danger' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
}

export const EARNING_STATUS: Record<string, { label: string; tone: 'warning' | 'success' | 'danger' }> = {
  pending: { label: 'Menunggu persetujuan', tone: 'warning' },
  approved: { label: 'Disetujui', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
}

/** Sama dengan public.effective_attendance: event asli yang tidak dikoreksi + event koreksi, urut waktu. */
export function effectiveEvents(events: AttendanceEvent[]) {
  const corrected = new Set(events.map((e) => e.corrects_id).filter((v): v is number => v !== null))
  return events.filter((e) => !corrected.has(e.id)).sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
}

/** Tombol yang boleh muncul berikutnya — urutan yang sama ditegakkan ulang oleh attendance_action di database. */
export function nextActions(effective: AttendanceEvent[]): AttendanceKind[] {
  const last = effective.at(-1)?.kind
  if (!last) return ['clock_in']
  if (last === 'clock_in' || last === 'break_end' || last === 'off_end') return ['break_start', 'clock_out']
  if (last === 'break_start') return ['break_end']
  return []
}

export function firstOf(effective: AttendanceEvent[], kind: AttendanceKind) {
  return effective.find((e) => e.kind === kind)?.at ?? null
}

export function breakMinutes(effective: AttendanceEvent[], now = Date.now()) {
  let total = 0
  let start: number | null = null
  for (const e of effective) {
    if (e.kind === 'break_start') start = Date.parse(e.at)
    if (e.kind === 'break_end' && start !== null) {
      total += Date.parse(e.at) - start
      start = null
    }
  }
  if (start !== null) {
    const out = firstOf(effective, 'clock_out')
    total += (out ? Date.parse(out) : now) - start
  }
  return Math.floor(total / 60000)
}

/** Menit Off/Izin (diatur owner); tidak dihitung kerja dan terpisah dari istirahat. */
export function offMinutes(effective: AttendanceEvent[], now = Date.now()) {
  let total = 0
  let start: number | null = null
  for (const e of effective) {
    if (e.kind === 'off_start') start = Date.parse(e.at)
    if (e.kind === 'off_end' && start !== null) {
      total += Date.parse(e.at) - start
      start = null
    }
  }
  if (start !== null) {
    const out = firstOf(effective, 'clock_out')
    total += (out ? Date.parse(out) : now) - start
  }
  return Math.floor(total / 60000)
}

export function netMinutes(effective: AttendanceEvent[], now = Date.now()) {
  const inAt = firstOf(effective, 'clock_in')
  if (!inAt) return 0
  const out = firstOf(effective, 'clock_out')
  const gross = Math.floor(((out ? Date.parse(out) : now) - Date.parse(inAt)) / 60000)
  return Math.max(0, gross - breakMinutes(effective, now) - offMinutes(effective, now))
}

type AllowanceRule = { target_hours: number | string; amount_rp: number; cap_at_target: boolean }
type BonusRule = {
  method: string
  fixed_rp: number | null
  per_hour_rp: number | null
  day_per_hour_rp: number | null
  night_per_hour_rp: number | null
}

/** Estimasi tampilan saja. Nilai resmi dihitung _compute_earning di database saat absen pulang. */
export function estimateAllowance(net: number, rule: AllowanceRule | null) {
  if (!rule) return null
  const target = Number(rule.target_hours)
  const hours = rule.cap_at_target ? Math.min(net / 60, target) : net / 60
  return Math.round((hours / target) * rule.amount_rp)
}

export function estimateBonus(net: number, rule: BonusRule | null, night = false) {
  if (!rule) return null
  if (rule.method === 'fixed_per_shift') return rule.fixed_rp
  if (rule.method === 'per_net_hour') return Math.round((net / 60) * (rule.per_hour_rp ?? 0))
  return Math.round((net / 60) * ((night ? rule.night_per_hour_rp : rule.day_per_hour_rp) ?? 0))
}

export function bonusRuleLabel(rule: BonusRule | null) {
  if (!rule) return 'belum dikonfigurasi'
  if (rule.method === 'fixed_per_shift') return `tetap Rp${(rule.fixed_rp ?? 0).toLocaleString('id-ID')} per shift`
  if (rule.method === 'per_net_hour') return `Rp${(rule.per_hour_rp ?? 0).toLocaleString('id-ID')} per jam bersih`
  return `siang Rp${(rule.day_per_hour_rp ?? 0).toLocaleString('id-ID')}/jam · malam Rp${(rule.night_per_hour_rp ?? 0).toLocaleString('id-ID')}/jam`
}

export type ScheduleRow = { admin_id: string; weekday: number; start_time: string; end_time: string; effective_from: string; effective_to: string | null }

/**
 * Hari kerja dari jadwal reguler (minggu yang dimulai Senin `week`) yang belum punya shift reguler.
 * Mengikuti aturan generate_regular_shifts: hanya tanggal di dalam masa berlaku versi jadwal.
 */
export function missingRegularShifts(templates: ScheduleRow[], shifts: { admin_id: string; kind: string; shift_date: string }[], week: string) {
  const have = new Set(shifts.filter((s) => s.kind === 'regular').map((s) => `${s.admin_id}|${s.shift_date}`))
  return templates
    .map((t) => {
      const d = new Date(`${week}T12:00:00Z`)
      d.setUTCDate(d.getUTCDate() + t.weekday - 1)
      return { ...t, date: d.toISOString().slice(0, 10) }
    })
    .filter((t) => t.date >= t.effective_from && (!t.effective_to || t.date <= t.effective_to) && !have.has(`${t.admin_id}|${t.date}`))
}
