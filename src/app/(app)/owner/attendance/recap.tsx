import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Card, EmptyState, Note, Pill, Stat, Table, btnDark, inputCls } from '@/components/ui'
import { addDays, dateLabel, isYmd, jktDate, jktTime, minutesLabel, weekStart } from '@/lib/format'
import { ABSENCE, breakMinutes, effectiveEvents, firstOf, netMinutes, offMinutes, shiftLabel, type AbsenceKind, type AttendanceEvent } from '@/lib/attendance'
import type { Profile } from './sections'

type Shift = {
  id: string
  admin_id: string
  kind: 'regular' | 'extra'
  shift_date: string
  planned_start: string
  planned_end: string
  status: string
  absence_kind: AbsenceKind | null
  attendance_events: AttendanceEvent[]
}
type AbsenceNote = { shift_id: string; note: string | null; at: string }

export type RecapPeriod = 'hari' | 'minggu' | 'bulan' | 'rentang'
const PERIODS: { key: RecapPeriod; label: string }[] = [
  { key: 'hari', label: 'Harian' },
  { key: 'minggu', label: 'Mingguan' },
  { key: 'bulan', label: 'Bulanan' },
  { key: 'rentang', label: 'Rentang tanggal' },
]
const MAX_DAYS = 93

/** Rentang tanggal dari parameter URL. Rentang bebas dibatasi 93 hari agar halaman tetap ringan. */
export function recapRange(sp: Record<string, string | undefined>, fallbackWeek: string) {
  const p: RecapPeriod = PERIODS.some((x) => x.key === sp.p) ? (sp.p as RecapPeriod) : 'minggu'
  // Input bulan mengirim "YYYY-MM"; jadikan tanggal 1.
  const d = sp.d && /^\d{4}-\d{2}$/.test(sp.d) ? `${sp.d}-01` : sp.d
  const anchor = isYmd(d) ? d : p === 'minggu' ? fallbackWeek : jktDate()
  if (p === 'hari') return { p, from: anchor, to: anchor, anchor }
  if (p === 'minggu') {
    const w = weekStart(anchor)
    return { p, from: w, to: addDays(w, 6), anchor: w }
  }
  if (p === 'bulan') {
    const from = `${anchor.slice(0, 7)}-01`
    const next = new Date(`${from}T12:00:00Z`)
    next.setUTCMonth(next.getUTCMonth() + 1)
    return { p, from, to: addDays(next.toISOString().slice(0, 10), -1), anchor: from }
  }
  let from = isYmd(sp.from) ? sp.from : addDays(jktDate(), -13)
  let to = isYmd(sp.to) ? sp.to : jktDate()
  if (to < from) [from, to] = [to, from]
  if (addDays(from, MAX_DAYS - 1) < to) to = addDays(from, MAX_DAYS - 1)
  return { p, from, to, anchor: from }
}

const monthLabel = (ymd: string) => new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date(`${ymd}T12:00:00+07:00`))

/**
 * Ringkasan satu shift dari event absensi efektif (setelah koreksi), memakai fungsi yang sama dengan tab Absensi.
 * Terlambat = masuk setelah jam mulai jadwal (belum ada aturan toleransi yang dikonfigurasi, jadi tidak ada toleransi).
 */
function summarize(s: Shift, now: number) {
  const eff = effectiveEvents(s.attendance_events ?? [])
  const inAt = firstOf(eff, 'clock_in')
  const outAt = firstOf(eff, 'clock_out')
  const late = inAt ? Math.max(0, Math.floor((Date.parse(inAt) - Date.parse(s.planned_start)) / 60000)) : 0
  const ended = Date.parse(s.planned_end) < now
  const done = s.status === 'completed'
  const open = !done && !s.absence_kind && s.status !== 'cancelled' && (s.status === 'in_progress' || s.status === 'incomplete' || (ended && !!inAt))
  return {
    eff,
    inAt,
    outAt,
    present: !!inAt,
    net: inAt ? netMinutes(eff, now) : 0,
    rest: inAt ? breakMinutes(eff, now) : 0,
    off: inAt ? offMinutes(eff, now) : 0,
    late,
    done,
    open,
    noShow: !inAt && !s.absence_kind && s.status !== 'cancelled' && ended,
  }
}

type Totals = { days: Set<string>; net: number; rest: number; off: number; late: number; lateMin: number; done: number; open: number; noShow: number; shifts: number } & Record<AbsenceKind, number>
const empty = (): Totals => ({ days: new Set(), net: 0, rest: 0, off: 0, late: 0, lateMin: 0, done: 0, open: 0, noShow: 0, shifts: 0, tidak_masuk: 0, izin: 0, sakit: 0 })

export async function RecapTab({ supabase, profiles, sp, week }: { supabase: SupabaseClient; profiles: Profile[]; sp: Record<string, string | undefined>; week: string }) {
  const { p, from, to, anchor } = recapRange(sp, week)
  const staffId = profiles.some((x) => x.id === sp.staff) ? sp.staff : undefined
  const now = Date.now()

  let q = supabase
    .from('shifts')
    .select('id, admin_id, kind, shift_date, planned_start, planned_end, status, absence_kind, attendance_events(id, kind, at, corrects_id, correction_reason)')
    .gte('shift_date', from)
    .lte('shift_date', to)
    .neq('status', 'cancelled')
    .order('shift_date')
    .order('planned_start')
  if (staffId) q = q.eq('admin_id', staffId)
  const { data } = await q
  const shifts = (data ?? []) as unknown as Shift[]

  // Keterangan ketidakhadiran terakhir per shift (log append-only).
  const absentIds = shifts.filter((s) => s.absence_kind).map((s) => s.id)
  const { data: notes } = absentIds.length
    ? await supabase.from('shift_absence_log').select('shift_id, note, at').in('shift_id', absentIds).order('at', { ascending: false })
    : { data: [] as AbsenceNote[] }
  const noteOf = (id: string) => (notes as AbsenceNote[] | null)?.find((n) => n.shift_id === id)?.note ?? null

  const staff = profiles.filter((x) => x.role === 'staff' && (x.is_active || shifts.some((s) => s.admin_id === x.id)))
  const per = new Map<string, Totals>()
  const team = empty()
  const rows = shifts.map((s) => ({ s, x: summarize(s, now) }))
  for (const { s, x } of rows) {
    const t = per.get(s.admin_id) ?? empty()
    for (const tot of [t, team]) {
      tot.shifts++
      if (s.absence_kind) tot[s.absence_kind]++
      if (x.present) tot.days.add(`${s.admin_id}|${s.shift_date}`)
      tot.net += x.net
      tot.rest += x.rest
      tot.off += x.off
      if (x.late > 0) {
        tot.late++
        tot.lateMin += x.late
      }
      if (x.done) tot.done++
      if (x.open) tot.open++
      if (x.noShow) tot.noShow++
    }
    per.set(s.admin_id, t)
  }

  const qs = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams({ tab: 'laporan', p, d: anchor, ...(p === 'rentang' ? { from, to } : {}), ...(staffId ? { staff: staffId } : {}) })
    Object.entries(o).forEach(([k, v]) => (v === undefined ? u.delete(k) : u.set(k, v)))
    return `/owner/attendance?${u.toString()}`
  }
  const step = p === 'hari' ? 1 : p === 'minggu' ? 7 : 0
  const prev = p === 'bulan' ? (() => { const d = new Date(`${from}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10) })() : addDays(anchor, -step)
  const next = p === 'bulan' ? addDays(to, 1) : addDays(anchor, step)
  const title = p === 'hari' ? dateLabel(from, 'long') : p === 'bulan' ? monthLabel(from) : `${dateLabel(from)} – ${dateLabel(to)}`
  const selected = staffId ? profiles.find((x) => x.id === staffId) : null

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-3">
          <nav aria-label="Periode rekap" className="flex flex-wrap gap-1 rounded-xl bg-cream-100 p-1">
            {PERIODS.map((x) => (
              <Link
                key={x.key}
                href={qs({ p: x.key, d: x.key === 'minggu' ? weekStart(jktDate()) : jktDate(), from: undefined, to: undefined })}
                scroll={false}
                aria-current={p === x.key ? 'page' : undefined}
                className={`btn-press flex min-h-9 flex-1 items-center justify-center rounded-lg px-3 text-sm font-semibold sm:flex-none ${p === x.key ? 'bg-white text-navy-900 shadow-sm' : 'text-ink-500 hover:text-navy-900'}`}
              >
                {x.label}
              </Link>
            ))}
          </nav>
          <form method="get" action="/owner/attendance" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="laporan" />
            <input type="hidden" name="p" value={p} />
            {p === 'rentang' ? (
              <>
                <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-xs font-semibold text-ink-500 sm:flex-none">
                  Dari
                  <input type="date" name="from" defaultValue={from} className={inputCls} />
                </label>
                <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-xs font-semibold text-ink-500 sm:flex-none">
                  Sampai
                  <input type="date" name="to" defaultValue={to} className={inputCls} />
                </label>
              </>
            ) : (
              <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs font-semibold text-ink-500 sm:flex-none">
                {p === 'hari' ? 'Tanggal' : p === 'minggu' ? 'Minggu yang memuat tanggal' : 'Bulan'}
                {p === 'bulan' ? (
                  <input type="month" name="d" defaultValue={from.slice(0, 7)} className={inputCls} />
                ) : (
                  <input type="date" name="d" defaultValue={p === 'hari' ? from : anchor} className={inputCls} />
                )}
              </label>
            )}
            <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs font-semibold text-ink-500 sm:flex-none">
              Staf
              <select name="staff" defaultValue={staffId ?? ''} className={inputCls}>
                <option value="">Semua staf</option>
                {profiles.filter((x) => x.role === 'staff').map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
              </select>
            </label>
            <button className={btnDark}>Terapkan</button>
          </form>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-display text-base font-semibold">
              {title}
              {selected && <span className="text-ink-500"> · {selected.full_name}</span>}
            </span>
            {p !== 'rentang' && (
              <span className="flex gap-1.5">
                <Link href={qs({ d: p === 'bulan' ? prev.slice(0, 7) + '-01' : prev })} scroll={false} className="btn-press flex min-h-9 items-center rounded-lg border border-cream-300 bg-white px-3 text-sm font-semibold">← Sebelumnya</Link>
                <Link href={qs({ d: next })} scroll={false} className="btn-press flex min-h-9 items-center rounded-lg border border-cream-300 bg-white px-3 text-sm font-semibold">Berikutnya →</Link>
              </span>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat icon="calendar" label="Hari hadir" value={team.days.size} sub={`${team.shifts} shift terjadwal`} />
        <Stat icon="clock" label="Jam kerja bersih" value={minutesLabel(team.net)} sub="setelah istirahat & Off/Izin" />
        <Stat icon="coffee" label="Total istirahat" value={minutesLabel(team.rest)} sub={team.off ? `Off/Izin ${minutesLabel(team.off)}` : 'tidak ada Off/Izin'} />
        <Stat icon="alert" label="Terlambat" value={team.late} sub={team.late ? `total ${minutesLabel(team.lateMin)} dari jam mulai` : 'masuk tepat waktu'} />
        <Stat icon="check" label="Shift selesai" value={team.done} sub={`${team.open} belum selesai`} />
        <Stat icon="info" accent="sky" label="Izin" value={team.izin} />
        <Stat icon="shield" accent="peach" label="Sakit" value={team.sakit} />
        <Stat icon="close" accent="lavender" label="Tidak masuk" value={team.tidak_masuk} sub={team.noShow ? `+${team.noShow} tanpa absen & tanpa keterangan` : 'ditandai owner'} />
      </div>

      {!selected && (
        <Card title="Rekap per staf" aside={<span className="text-xs text-ink-500">Pilih nama untuk detail</span>}>
          {!staff.length ? (
            <EmptyState title="Belum ada staf" icon="user" />
          ) : (
            <>
              {/* HP: kartu per staf. Layar lebar: tabel. */}
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:hidden">
                {staff.map((x) => {
                  const t = per.get(x.id) ?? empty()
                  return (
                    <li key={x.id}>
                      <Link href={qs({ staff: x.id })} className="card-hover flex flex-col gap-2 rounded-xl border border-cream-300 bg-white p-3.5">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{x.full_name}</span>
                          <span className="text-xs text-ink-500">{t.days.size} hari hadir</span>
                        </span>
                        <span className="grid grid-cols-3 gap-2 text-xs">
                          <span className="flex flex-col"><b className="text-sm">{minutesLabel(t.net)}</b><span className="text-ink-500">bersih</span></span>
                          <span className="flex flex-col"><b className="text-sm">{minutesLabel(t.rest)}</b><span className="text-ink-500">istirahat</span></span>
                          <span className="flex flex-col"><b className="text-sm">{t.late}×</b><span className="text-ink-500">terlambat</span></span>
                        </span>
                        <span className="flex flex-wrap gap-1">
                          <Pill tone="success">Selesai {t.done}</Pill>
                          {!!t.open && <Pill tone="warning">Belum selesai {t.open}</Pill>}
                          {(Object.keys(ABSENCE) as AbsenceKind[]).filter((k) => t[k]).map((k) => <Pill key={k} tone={ABSENCE[k].tone}>{ABSENCE[k].label} {t[k]}</Pill>)}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
              <div className="hidden md:block">
                <Table head={['Staf', 'Hari hadir', 'Jam bersih', 'Istirahat', 'Terlambat', 'Selesai', 'Belum selesai', 'Izin', 'Sakit', 'Tidak masuk']}>
                  {staff.map((x) => {
                    const t = per.get(x.id) ?? empty()
                    return (
                      <tr key={x.id}>
                        <td className="font-semibold"><Link href={qs({ staff: x.id })} className="text-navy-900 underline-offset-4 hover:underline">{x.full_name}</Link></td>
                        <td>{t.days.size}</td>
                        <td className="whitespace-nowrap font-semibold">{minutesLabel(t.net)}</td>
                        <td className="whitespace-nowrap">{minutesLabel(t.rest)}{t.off ? <div className="text-xs text-ink-500">Off {minutesLabel(t.off)}</div> : null}</td>
                        <td>{t.late ? <>{t.late}× <div className="text-xs text-ink-500">{minutesLabel(t.lateMin)}</div></> : '—'}</td>
                        <td>{t.done}</td>
                        <td>{t.open || '—'}</td>
                        <td>{t.izin || '—'}</td>
                        <td>{t.sakit || '—'}</td>
                        <td>{t.tidak_masuk || '—'}{t.noShow ? <div className="text-xs text-ink-500">+{t.noShow} tanpa keterangan</div> : null}</td>
                      </tr>
                    )
                  })}
                </Table>
              </div>
            </>
          )}
        </Card>
      )}

      {selected && (
        <Card title={`Detail ${selected.full_name}`} aside={<Link href={qs({ staff: undefined })} scroll={false} className="text-sm font-semibold text-orange-700">← Semua staf</Link>}>
          {!rows.length ? (
            <EmptyState title="Tidak ada shift pada periode ini" icon="calendar" />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map(({ s, x }) => {
                const st = s.absence_kind
                  ? { label: ABSENCE[s.absence_kind].label, tone: ABSENCE[s.absence_kind].tone }
                  : x.noShow
                    ? { label: 'Tidak hadir · tanpa keterangan', tone: 'danger' as const }
                    : shiftLabel(s.status, x.eff)
                const note = s.absence_kind ? noteOf(s.id) : null
                return (
                  <li key={s.id} className="flex flex-col gap-2 rounded-xl border border-cream-300 bg-white p-3.5 sm:flex-row sm:items-center sm:gap-4">
                    <span className="flex min-w-[9.5rem] flex-col">
                      <span className="font-semibold">{dateLabel(s.shift_date, 'long')}</span>
                      <span className="text-xs text-ink-500">
                        {s.kind === 'regular' ? 'Reguler' : 'Tambahan'} · {jktTime(s.planned_start)}–{jktTime(s.planned_end)}
                      </span>
                    </span>
                    {s.absence_kind ? (
                      <span className="flex-1 text-sm text-ink-500">{note ? `Keterangan: ${note}` : 'Tanpa keterangan tambahan.'}</span>
                    ) : !x.present ? (
                      <span className="flex-1 text-sm text-ink-500">{x.noShow ? 'Tidak ada absen masuk dan belum ditandai Izin/Sakit/Tidak Masuk.' : 'Shift belum dimulai.'}</span>
                    ) : (
                      <span className="grid flex-1 grid-cols-3 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
                        <span><span className="block text-xs text-ink-500">Masuk</span>{x.inAt ? jktTime(x.inAt) : '—'}{x.late > 0 && <span className="block text-xs font-semibold text-warning-700">+{minutesLabel(x.late)}</span>}</span>
                        <span><span className="block text-xs text-ink-500">Pulang</span>{x.outAt ? jktTime(x.outAt) : '—'}</span>
                        <span><span className="block text-xs text-ink-500">Istirahat</span>{minutesLabel(x.rest)}</span>
                        <span><span className="block text-xs text-ink-500">Off/Izin</span>{x.off ? minutesLabel(x.off) : '—'}</span>
                        <span><span className="block text-xs text-ink-500">Bersih</span><b>{minutesLabel(x.net)}</b></span>
                      </span>
                    )}
                    <span className="sm:ml-auto"><Pill tone={st.tone}>{st.label}</Pill></span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}

      <Note>
        Rekap dihitung dari absensi efektif (setelah koreksi) dengan cara yang sama seperti tab Absensi. Shift yang masih berjalan dihitung sampai saat ini.
        Terlambat = masuk setelah jam mulai jadwal, tanpa toleransi karena belum ada aturan toleransi yang dikonfigurasi. Uang saku & pencairan tetap di tab
        Rekap &amp; pembayaran.
      </Note>
    </div>
  )
}
