import type { SupabaseClient } from '@supabase/supabase-js'
import { Card, Pill } from '@/components/ui'
import { addDays, jktDate, jktTime, minutesLabel } from '@/lib/format'
import { KIND_LABEL, WORK_STATUS, breakMinutes, effectiveEvents, netMinutes, offMinutes, workStatus, type AttendanceEvent } from '@/lib/attendance'
import { StatusControl } from './status-control'
import type { Profile } from './sections'

type Shift = { id: string; code: string; admin_id: string; shift_date: string; planned_start: string; planned_end: string; status: string; attendance_events: AttendanceEvent[] }

/**
 * Status kerja tiap admin aktif saat ini, dengan kontrol owner. Shift yang dipakai: shift terbuka (sedang bekerja /
 * tidak lengkap) bila ada, selain itu shift hari ini. Data shift & event dibaca dengan sesi owner (RLS).
 */
export async function StatusCard({ supabase, profiles }: { supabase: SupabaseClient; profiles: Profile[] }) {
  const today = jktDate()
  const { data } = await supabase
    .from('shifts')
    .select('id, code, admin_id, shift_date, planned_start, planned_end, status, attendance_events(id, kind, at, corrects_id, correction_reason, actor_id)')
    .gte('shift_date', addDays(today, -1))
    .lte('shift_date', today)
    .neq('status', 'cancelled')
    .order('planned_start')
  const shifts = (data ?? []) as Shift[]
  const staff = profiles.filter((p) => p.role === 'staff' && p.is_active)
  const nameOf = (id?: string) => profiles.find((p) => p.id === id)?.full_name ?? '—'
  const pick = (adminId: string) => {
    const mine = shifts.filter((s) => s.admin_id === adminId)
    return mine.find((s) => s.status === 'in_progress' || s.status === 'incomplete') ?? mine.filter((s) => s.shift_date === today).at(-1)
  }

  return (
    <Card title="Status admin saat ini" aside={<span className="text-xs text-ink-500">Diperbarui otomatis tiap 30 detik</span>}>
      <p className="text-sm text-ink-500">
        Owner bisa mengubah status bila admin lupa menekan tombol. Waktu Istirahat dan Off/Izin tidak dihitung sebagai jam kerja;
        setiap perubahan tercatat dengan waktu, status sebelum/sesudah, alasan, dan pelaku.
      </p>
      <ul className="flex flex-col gap-3">
        {staff.map((p) => {
          const s = pick(p.id)
          if (!s)
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-300 p-3">
                <span className="font-semibold">{p.full_name}</span>
                <span className="text-sm text-ink-500">Tidak ada shift hari ini</span>
              </li>
            )
          const eff = effectiveEvents(s.attendance_events ?? [])
          const { status, since } = workStatus(eff)
          const st = WORK_STATUS[status]
          const changes = eff.filter((e) => e.actor_id && e.actor_id !== s.admin_id)
          return (
            <li key={p.id} className="flex flex-col gap-3 rounded-xl border border-cream-300 p-3 sm:p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-display text-base font-semibold">{p.full_name}</span>
                  <span className="text-xs text-ink-500">
                    {s.code} · jadwal {jktTime(s.planned_start)}–{jktTime(s.planned_end)}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Pill tone={st.tone}>{st.label}</Pill>
                  {since && <span className="text-xs text-ink-500">sejak {jktTime(since)}</span>}
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div><dt className="text-xs text-ink-500">Kerja bersih</dt><dd className="font-semibold">{minutesLabel(netMinutes(eff))}</dd></div>
                <div><dt className="text-xs text-ink-500">Istirahat</dt><dd>{minutesLabel(breakMinutes(eff))}</dd></div>
                <div><dt className="text-xs text-ink-500">Off/Izin</dt><dd>{minutesLabel(offMinutes(eff))}</dd></div>
              </dl>
              {s.status === 'completed' ? (
                <p className="text-xs text-ink-500">Shift selesai. Ubah waktu lewat Koreksi di tab Absensi.</p>
              ) : (
                <StatusControl shiftId={s.id} adminName={p.full_name} current={status} />
              )}
              {eff.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-semibold text-orange-700">
                    Riwayat shift ini ({eff.length}){changes.length ? ` · ${changes.length} oleh owner` : ''}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {eff.map((e) => (
                      <li key={e.id}>
                        {jktTime(e.at)} · {KIND_LABEL[e.kind]} · oleh {e.actor_id === s.admin_id ? 'admin' : nameOf(e.actor_id)}
                        {e.correction_reason ? ` — ${e.correction_reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          )
        })}
        {!staff.length && <li className="text-sm text-ink-500">Belum ada admin aktif.</li>}
      </ul>
    </Card>
  )
}
