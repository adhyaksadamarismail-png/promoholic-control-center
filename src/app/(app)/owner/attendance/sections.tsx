import type { SupabaseClient } from '@supabase/supabase-js'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, Pill, Table, inputCls, labelCls } from '@/components/ui'
import { WEEKDAYS, addDays, dateLabel, isYmd, isoToJktLocal, jktDate, jktDateTime, jktTime, minutesLabel, rupiah } from '@/lib/format'
import {
  ABSENCE,
  EARNING_STATUS,
  KIND_LABEL,
  shiftLabel,
  bonusRuleLabel,
  breakMinutes,
  effectiveEvents,
  firstOf,
  missingRegularShifts,
  netMinutes,
  type AbsenceKind,
  type AttendanceEvent,
  type AttendanceKind,
  type ScheduleRow,
} from '@/lib/attendance'
import {
  addBonusRule,
  addExtraShift,
  approvePayroll,
  buildPayrolls,
  correctAttendance,
  createStaff,
  decideEarning,
  flagIncomplete,
  generateWeek,
  markPaid,
  resetPassword,
  setAbsence,
  setSchedule,
  setStaffActive,
  setStaffPermission,
  verifyBenefit,
} from './actions'
import { ReceiptViewer } from './receipt-viewer'
import { AbsenceForm } from './absence-form'

export type Profile = {
  id: string
  username: string
  full_name: string
  role: 'owner' | 'staff'
  is_active: boolean
  can_restock_panel: boolean
  must_change_password: boolean
}
type Props = { supabase: SupabaseClient; week: string; profiles: Profile[]; sp?: Record<string, string | undefined> }

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}
const nameOf = (profiles: Profile[], id: string) => profiles.find((p) => p.id === id)?.full_name ?? '—'
const staffOf = (profiles: Profile[]) => profiles.filter((p) => p.role === 'staff')

/* ───────────── Absensi ───────────── */
export async function AttendanceTab({ supabase, week, profiles }: Props) {
  const [{ data }, { data: templates }] = await Promise.all([
    supabase
    .from('shifts')
    .select('id, code, admin_id, kind, shift_date, planned_start, planned_end, status, absence_kind, needs_review, review_reasons, attendance_events(id, kind, at, corrects_id, correction_reason)')
    .gte('shift_date', week)
    .lte('shift_date', addDays(week, 6))
    .order('planned_start'),
    supabase.from('schedule_templates').select('admin_id, weekday, start_time, end_time, effective_from, effective_to')
      .lte('effective_from', addDays(week, 6)).or(`effective_to.is.null,effective_to.gte.${week}`),
  ])
  const shifts = (data ?? []) as {
    id: string; code: string; admin_id: string; kind: string; shift_date: string; planned_start: string; planned_end: string
    status: string; absence_kind: AbsenceKind | null; needs_review: boolean; review_reasons: string[]; attendance_events: AttendanceEvent[]
  }[]
  type AbsenceLog = { id: number; shift_id: string; kind: AbsenceKind | null; previous_kind: AbsenceKind | null; note: string | null; reason: string | null; attachment_path: string | null; actor_id: string; at: string }
  const { data: logData } = shifts.some((s) => s.absence_kind)
    ? await supabase.from('shift_absence_log').select('id, shift_id, kind, previous_kind, note, reason, attachment_path, actor_id, at').in('shift_id', shifts.map((s) => s.id)).order('id')
    : { data: [] }
  const logs = (logData ?? []) as AbsenceLog[]
  const staffList = staffOf(profiles).filter((p) => p.is_active).map((p) => ({ id: p.id, name: p.full_name }))
  // Bisa ditandai: belum ada absensi dan shift belum ditutup. Aturan sebenarnya di set_shift_absence.
  const absenceShifts = shifts
    .filter((s) => (s.status === 'scheduled' || s.status === 'incomplete') && !effectiveEvents(s.attendance_events ?? []).length)
    .map((s) => ({ id: s.id, admin_id: s.admin_id, label: `${dateLabel(s.shift_date)} · ${jktTime(s.planned_start)}–${jktTime(s.planned_end)}${s.kind === 'extra' ? ' · tambahan' : ''}` }))
  const kinds: AttendanceKind[] = ['clock_in', 'break_start', 'break_end', 'clock_out']
  // Jadwal reguler staf aktif yang belum menjadi shift di minggu ini (shift hanya dibuat lewat tombol / simpan jadwal).
  const activeStaff = new Set(staffOf(profiles).filter((p) => p.is_active).map((p) => p.id))
  const missing = missingRegularShifts(((templates ?? []) as ScheduleRow[]).filter((t) => activeStaff.has(t.admin_id)), shifts, week)

  return (
    <>
      {missing.length > 0 && (
        <Note tone="warning">
          {missing.length} shift reguler dari jadwal belum dibuat untuk minggu {dateLabel(week)} – {dateLabel(addDays(week, 6))} (
          {[...new Set(missing.map((m) => nameOf(profiles, m.admin_id)))].join(', ')}). Staf tidak melihat jadwalnya sampai shift dibuat:
          tekan &quot;Buat shift reguler minggu ini&quot;.
        </Note>
      )}
      <div className="flex flex-wrap gap-3">
        <ActionForm action={generateWeek} className="flex flex-col gap-2">
          <input type="hidden" name="week" value={week} />
          <SubmitButton variant="primary">Buat shift reguler minggu ini</SubmitButton>
        </ActionForm>
        <ActionForm action={flagIncomplete} className="flex flex-col gap-2">
          <SubmitButton variant="ghost">Tandai shift tanpa absen pulang</SubmitButton>
        </ActionForm>
        <AbsenceForm staff={staffList} shifts={absenceShifts} />
        <details className="rounded-xl border border-cream-300 bg-white px-4 py-2.5 text-sm">
          <summary className="cursor-pointer font-semibold">+ Shift tambahan</summary>
          <ActionForm action={addExtraShift} className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className={labelCls}>
              Staf
              <select name="admin" required className={inputCls}>
                {staffOf(profiles).filter((p) => p.is_active).map((p) => (
                  <option key={p.id} value={p.id}>{p.full_name}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              Mulai (WIB)
              <input type="datetime-local" name="start" required className={inputCls} defaultValue={`${week}T14:00`} />
            </label>
            <label className={labelCls}>
              Selesai (WIB)
              <input type="datetime-local" name="end" required className={inputCls} defaultValue={`${week}T20:00`} />
            </label>
            <div className="sm:col-span-3">
              <SubmitButton variant="accent">Simpan shift tambahan</SubmitButton>
            </div>
          </ActionForm>
        </details>
      </div>

      <Card title="Absensi minggu ini">
        <Table head={['Tanggal', 'Admin', 'Jenis', 'Jadwal', 'Masuk', 'Istirahat', 'Pulang', 'Bersih', 'Pemeriksaan', '']} empty="Belum ada shift. Buat shift reguler dari jadwal.">
          {shifts.map((s) => {
            const eff = effectiveEvents(s.attendance_events ?? [])
            const corrected = (s.attendance_events ?? []).filter((e) => e.corrects_id)
            const absent = s.absence_kind ? ABSENCE[s.absence_kind] : null
            const st = absent ?? shiftLabel(s.status, eff)
            const history = logs.filter((l) => l.shift_id === s.id)
            const current = history.at(-1)
            return (
              <tr key={s.id}>
                <td className="whitespace-nowrap">{dateLabel(s.shift_date)}</td>
                <td className="font-semibold">{nameOf(profiles, s.admin_id)}</td>
                <td><Pill tone={s.kind === 'regular' ? 'info' : 'orange'}>{s.kind === 'regular' ? 'Reguler' : 'Tambahan'}</Pill></td>
                <td className="whitespace-nowrap">{jktTime(s.planned_start)}–{jktTime(s.planned_end)}</td>
                <td>{jktTime(firstOf(eff, 'clock_in'))}</td>
                <td>{eff.some((e) => e.kind === 'break_start') ? minutesLabel(breakMinutes(eff)) : '—'}</td>
                <td>{jktTime(firstOf(eff, 'clock_out'))}</td>
                <td className="whitespace-nowrap">{firstOf(eff, 'clock_in') ? minutesLabel(netMinutes(eff)) : '—'}</td>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    {st && <Pill tone={st.tone}>{st.label}</Pill>}
                    {!absent && s.review_reasons.map((r) => <Pill key={r} tone="warning">{r}</Pill>)}
                    {absent && current?.note && <span className="text-xs text-ink-500">{current.note}</span>}
                    {absent && current?.attachment_path && (
                      <a href={`/api/absence-proof/${current.id}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-orange-700">Lihat bukti</a>
                    )}
                    {corrected.map((c) => (
                      <span key={c.id} className="text-xs text-ink-500">
                        Dikoreksi: {KIND_LABEL[c.kind]} {jktTime(c.at)} — {c.correction_reason}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  {absent ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-semibold text-orange-700">Ubah status</summary>
                    <ActionForm action={setAbsence} className="mt-2 flex w-64 flex-col gap-2" confirm="Simpan perubahan status ketidakhadiran?">
                      <input type="hidden" name="shift" value={s.id} />
                      <select name="kind" className={inputCls} defaultValue={s.absence_kind ?? undefined}>
                        {(Object.keys(ABSENCE) as AbsenceKind[]).map((k) => <option key={k} value={k}>{ABSENCE[k].label}</option>)}
                        <option value="hapus">Hapus status (salah catat)</option>
                      </select>
                      <input name="note" maxLength={500} defaultValue={current?.note ?? ''} placeholder="Catatan (opsional)" className={inputCls} autoComplete="off" />
                      <input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-xs" aria-label="Ganti bukti (opsional)" />
                      <input name="reason" required minLength={3} maxLength={500} placeholder="Alasan koreksi" className={inputCls} autoComplete="off" />
                      <SubmitButton variant="ghost" pendingText="Menyimpan…">Simpan perubahan</SubmitButton>
                    </ActionForm>
                    <ul className="mt-2 flex w-64 flex-col gap-1 text-xs text-ink-500">
                      {history.map((l) => (
                        <li key={l.id}>
                          {jktDateTime(l.at)} · {l.previous_kind ? ABSENCE[l.previous_kind].label : 'Baru'} → {l.kind ? ABSENCE[l.kind].label : 'Dihapus'} · {nameOf(profiles, l.actor_id)}
                          {l.reason ? ` — ${l.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                  ) : (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-semibold text-orange-700">Koreksi</summary>
                    <ActionForm action={correctAttendance} className="mt-2 flex w-64 flex-col gap-2">
                      <input type="hidden" name="shift" value={s.id} />
                      <select name="kind" className={inputCls} defaultValue={firstOf(eff, 'clock_out') || !firstOf(eff, 'clock_in') ? 'clock_in' : 'clock_out'}>
                        {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </select>
                      <input type="datetime-local" name="at" required className={inputCls} defaultValue={isoToJktLocal(s.planned_start)} />
                      <input name="reason" required minLength={3} placeholder="Alasan koreksi" className={inputCls} />
                      <SubmitButton variant="ghost">Simpan koreksi</SubmitButton>
                    </ActionForm>
                  </details>
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
        <Note>
          Admin tidak bisa mengubah waktu absensi. Koreksi owner tidak menimpa data: event baru dicatat dengan alasan dan pelaku,
          event lama tetap tersimpan, dan uang saku shift itu dihitung ulang. Tidak Masuk, Izin, dan Sakit dipakai untuk shift yang belum dimulai;
          bila admin sudah masuk lalu izin di tengah shift, gunakan Off / Izin.
        </Note>
      </Card>
    </>
  )
}

/* ───────────── Uang saku & bonus ───────────── */
export async function EarningsTab({ supabase, week, profiles }: Props) {
  const [{ data }, { data: rule }] = await Promise.all([
    supabase
      .from('shift_earnings')
      .select('id, admin_id, kind, net_minutes, base_allowance, bonus, status, decision_note, allowance_rules(target_hours, amount_rp), bonus_rules(method, fixed_rp, per_hour_rp, day_per_hour_rp, night_per_hour_rp), shifts!inner(code, shift_date, needs_review, review_reasons)')
      .gte('shifts.shift_date', week)
      .lte('shifts.shift_date', addDays(week, 6))
      .order('computed_at'),
    supabase.from('allowance_rules').select('target_hours, amount_rp').order('effective_from', { ascending: false }).limit(1).maybeSingle(),
  ])
  type Row = {
    id: string; admin_id: string; kind: string; net_minutes: number; base_allowance: number; bonus: number; status: string; decision_note: string | null
    allowance_rules: { target_hours: number; amount_rp: number } | null
    bonus_rules: Parameters<typeof bonusRuleLabel>[0]
    shifts: { code: string; shift_date: string; needs_review: boolean; review_reasons: string[] }
  }
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, shifts: one(r.shifts)!, allowance_rules: one(r.allowance_rules), bonus_rules: one(r.bonus_rules) }))

  const decide = (r: (typeof rows)[number]) =>
    r.status === 'pending' ? (
      <ActionForm action={decideEarning} className="flex flex-col gap-1.5">
        <input type="hidden" name="earning" value={r.id} />
        <div className="flex gap-1.5">
          <SubmitButton name="decision" value="approve" variant="success" className="min-h-9 px-3">Setujui</SubmitButton>
          <SubmitButton name="decision" value="reject" variant="danger" className="min-h-9 px-3">Tolak</SubmitButton>
        </div>
        {r.shifts.needs_review && <span className="text-xs text-warning-700">Ditandai: periksa absensi dulu.</span>}
      </ActionForm>
    ) : (
      <Pill tone={EARNING_STATUS[r.status].tone}>{EARNING_STATUS[r.status].label}</Pill>
    )

  return (
    <>
      <Card title="Uang saku pokok — shift reguler">
        <Table head={['Tanggal', 'Admin', 'Jam bersih', 'Perhitungan', 'Uang saku', 'Status']} empty="Belum ada shift reguler yang selesai minggu ini.">
          {rows.filter((r) => r.kind === 'regular').map((r) => (
            <tr key={r.id}>
              <td>{dateLabel(r.shifts.shift_date)}</td>
              <td className="font-semibold">{nameOf(profiles, r.admin_id)}</td>
              <td>{minutesLabel(r.net_minutes)}</td>
              <td className="text-ink-500">
                {r.allowance_rules ? `${(r.net_minutes / 60).toFixed(2)} j ÷ ${Number(r.allowance_rules.target_hours)} j × ${rupiah(r.allowance_rules.amount_rp)}` : '—'}
                {r.shifts.review_reasons.map((x) => <div key={x}><Pill tone="warning">{x}</Pill></div>)}
              </td>
              <td className="font-semibold">{rupiah(r.base_allowance)}</td>
              <td>{decide(r)}</td>
            </tr>
          ))}
        </Table>
        <Note>
          Hanya shift reguler terjadwal yang menghasilkan uang saku pokok ({rule ? `${Number(rule.target_hours)} jam bersih = ${rupiah(rule.amount_rp)}` : 'aturan belum diisi'}).
          Shift yang ditandai sebaiknya dikoreksi atau dikonfirmasi sebelum disetujui.
        </Note>
      </Card>

      <Card title="Bonus — shift tambahan">
        <Table head={['Tanggal', 'Admin', 'Jam bersih', 'Aturan', 'Bonus', 'Status']} empty="Belum ada shift tambahan yang selesai minggu ini.">
          {rows.filter((r) => r.kind === 'extra').map((r) => (
            <tr key={r.id}>
              <td>{dateLabel(r.shifts.shift_date)}</td>
              <td className="font-semibold">{nameOf(profiles, r.admin_id)}</td>
              <td>{minutesLabel(r.net_minutes)}</td>
              <td className="text-ink-500">{bonusRuleLabel(r.bonus_rules)}</td>
              <td className="font-semibold">{rupiah(r.bonus)}</td>
              <td>{decide(r)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  )
}

/* ───────────── Rekap mingguan ───────────── */
export async function PayrollTab({ supabase, week, profiles }: Props) {
  const { data } = await supabase
    .from('weekly_payrolls')
    .select('id, admin_id, period_start, period_end, regular_scheduled, regular_completed, net_minutes, base_total, adjustments, adjustment_total, bonus_total, approved_total, status, payouts(code, paid_at, amount)')
    .eq('period_start', week)
  type Row = {
    id: string; admin_id: string; regular_scheduled: number; regular_completed: number; net_minutes: number
    base_total: number; adjustments: { amount: number; reason: string }[]; adjustment_total: number; bonus_total: number
    approved_total: number | null; status: 'open' | 'approved' | 'paid'; payouts: { code: string; paid_at: string; amount: number } | null
  }
  const rows = (data ?? []) as unknown as Row[]
  const staff = staffOf(profiles).filter((p) => p.is_active || rows.some((r) => r.admin_id === p.id))
  const { data: absentRows } = await supabase.from('shifts').select('admin_id, absence_kind').gte('shift_date', week).lte('shift_date', addDays(week, 6)).not('absence_kind', 'is', null)
  const absences = (id: string) =>
    (Object.keys(ABSENCE) as AbsenceKind[])
      .map((k) => ({ k, n: (absentRows ?? []).filter((a) => a.admin_id === id && a.absence_kind === k).length }))
      .filter((x) => x.n)
      .map((x) => `${ABSENCE[x.k].label} ${x.n}`)
      .join(' · ')
  const STATUS = { open: { l: 'Terbuka', t: 'warning' as const }, approved: { l: 'Disetujui', t: 'info' as const }, paid: { l: 'Dicairkan', t: 'success' as const } }

  return (
    <Card
      title={`Rekap ${dateLabel(week)} – ${dateLabel(addDays(week, 6))}`}
      aside={
        <ActionForm action={buildPayrolls} className="flex flex-col items-end gap-2">
          <input type="hidden" name="week" value={week} />
          {staff.map((p) => <input key={p.id} type="hidden" name="admin" value={p.id} />)}
          <SubmitButton variant="primary">Hitung / perbarui rekap</SubmitButton>
        </ActionForm>
      }
    >
      <Table head={['Admin', 'Shift reguler', 'Jam bersih', 'Uang saku pokok', 'Koreksi', 'Bonus', 'Total', 'Status', 'Pencairan']}>
        {staff.map((p) => {
          const r = one(rows.filter((x) => x.admin_id === p.id))
          if (!r)
            return (
              <tr key={p.id}>
                <td className="font-semibold">
                  {p.full_name}
                  {absences(p.id) && <div className="text-xs font-normal text-ink-500">{absences(p.id)}</div>}
                </td>
                <td colSpan={8} className="text-ink-500">Belum direkap.</td>
              </tr>
            )
          const payout = one(r.payouts)
          return (
            <tr key={p.id}>
              <td className="font-semibold">
                {p.full_name}
                {absences(p.id) && <div className="text-xs font-normal text-ink-500">{absences(p.id)}</div>}
              </td>
              <td>{r.regular_completed} / {r.regular_scheduled}</td>
              <td>{minutesLabel(r.net_minutes)}</td>
              <td>{rupiah(r.base_total)}</td>
              <td>
                {rupiah(r.adjustment_total)}
                {r.adjustments.map((a, i) => <div key={i} className="text-xs text-ink-500">{rupiah(a.amount)} · {a.reason}</div>)}
              </td>
              <td>{rupiah(r.bonus_total)}</td>
              <td className="font-semibold">{r.approved_total !== null ? rupiah(r.approved_total) : rupiah(Number(r.base_total) + Number(r.bonus_total))}</td>
              <td><Pill tone={STATUS[r.status].t}>{STATUS[r.status].l}</Pill></td>
              <td>
                {r.status === 'open' && (
                  <ActionForm action={approvePayroll} className="flex w-56 flex-col gap-1.5">
                    <input type="hidden" name="payroll" value={r.id} />
                    <input name="adj_amount" inputMode="numeric" placeholder="Koreksi Rp (opsional, boleh −)" className={inputCls} />
                    <input name="adj_reason" placeholder="Alasan koreksi" className={inputCls} />
                    <SubmitButton variant="success" className="min-h-9">Setujui rekap</SubmitButton>
                  </ActionForm>
                )}
                {r.status === 'approved' && (
                  <ActionForm action={markPaid} className="flex w-56 flex-col gap-1.5" confirm={`Tandai ${rupiah(r.approved_total)} untuk ${p.full_name} sudah dicairkan? Ini tidak bisa diulang.`}>
                    <input type="hidden" name="payroll" value={r.id} />
                    <input name="note" placeholder="Catatan (mis. transfer BCA)" className={inputCls} />
                    <SubmitButton variant="accent" className="min-h-9">Tandai dicairkan</SubmitButton>
                  </ActionForm>
                )}
                {payout && <span className="text-xs text-ink-500">{payout.code} · {jktDateTime(payout.paid_at)}</span>}
              </td>
            </tr>
          )
        })}
      </Table>
      <Note>
        Rekap hanya menjumlahkan uang saku & bonus yang sudah disetujui. Satu admin + satu periode = satu pencairan (dikunci database).
        Rekap yang sudah dicairkan tidak bisa diubah; selisih dimasukkan sebagai koreksi di periode berikutnya.
      </Note>
    </Card>
  )
}

/* ───────────── Benefit ───────────── */
const CLAIM_STATUS: Record<string, { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  pending: { label: 'Menunggu Verifikasi', tone: 'warning' },
  verified: { label: 'Terverifikasi', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
}
const CUP: Record<string, string> = { regular: 'Regular', large: 'Large' }

export async function BenefitTab({ supabase, week, profiles, sp = {} }: Props) {
  const from = isYmd(sp.from) ? sp.from : week
  const to = isYmd(sp.to) ? sp.to : addDays(week, 6)
  let q = supabase
    .from('benefit_claims')
    .select('id, admin_id, cup_size, status, claimed_at, voided_at, receipt_path, receipt_viewed_at, verified_by, verified_at, review_note, shifts!inner(code, shift_date)')
    .gte('shifts.shift_date', from)
    .lte('shifts.shift_date', to)
    .order('claimed_at', { ascending: false })
  if (sp.admin && profiles.some((p) => p.id === sp.admin)) q = q.eq('admin_id', sp.admin)
  if (sp.cup === 'regular' || sp.cup === 'large') q = q.eq('cup_size', sp.cup)
  if (sp.status && sp.status in CLAIM_STATUS) q = q.eq('status', sp.status)
  const [{ data }, { count: noClaim }] = await Promise.all([
    q,
    supabase.from('benefit_entitlements').select('id, shifts!inner(shift_date, status), benefit_claims(id)', { count: 'exact', head: true })
      .gte('shifts.shift_date', from).lte('shifts.shift_date', to).neq('shifts.status', 'absent').is('benefit_claims', null),
  ])
  type Row = {
    id: string; admin_id: string; cup_size: string | null; status: string; claimed_at: string; voided_at: string | null
    receipt_path: string | null; receipt_viewed_at: string | null; verified_by: string | null; verified_at: string | null
    review_note: string | null; shifts: { code: string; shift_date: string } | { code: string; shift_date: string }[]
  }
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, shift: one(r.shifts)! }))
  const pending = rows.filter((r) => r.status === 'pending' && !r.voided_at).length

  return (
    <Card title="Verifikasi Benefit KopKen" aside={<span className="text-sm text-ink-500">{pending} menunggu verifikasi · {noClaim ?? 0} shift belum diajukan</span>}>
      <form className="grid grid-cols-2 items-end gap-2 md:flex md:flex-wrap" role="search">
        <input type="hidden" name="tab" value="benefit" />
        <input type="hidden" name="week" value={week} />
        <label className={labelCls}>Dari<input type="date" name="from" defaultValue={from} className={inputCls} /></label>
        <label className={labelCls}>Sampai<input type="date" name="to" defaultValue={to} className={inputCls} /></label>
        <label className={labelCls}>
          Admin
          <select name="admin" defaultValue={sp.admin ?? ''} className={inputCls}>
            <option value="">Semua admin</option>
            {staffOf(profiles).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          Ukuran
          <select name="cup" defaultValue={sp.cup ?? ''} className={inputCls}>
            <option value="">Semua ukuran</option>
            <option value="regular">Regular</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className={labelCls}>
          Status
          <select name="status" defaultValue={sp.status ?? ''} className={inputCls}>
            <option value="">Semua status</option>
            {Object.entries(CLAIM_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <button className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Terapkan</button>
      </form>

      <Table head={['Tanggal shift', 'ID shift', 'Admin', 'Ukuran', 'Diajukan', 'Bukti receipt', 'Status', 'Keputusan / catatan']} empty="Tidak ada pengajuan untuk filter ini.">
        {rows.map((r) => {
          const st = r.voided_at ? { label: 'Dibatalkan', tone: 'neutral' as const } : CLAIM_STATUS[r.status]
          return (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{dateLabel(r.shift.shift_date)}</td>
              <td className="whitespace-nowrap font-mono text-[13px]">{r.shift.code}</td>
              <td className="font-semibold">{nameOf(profiles, r.admin_id)}</td>
              <td>{r.cup_size ? CUP[r.cup_size] : '—'}</td>
              <td className="whitespace-nowrap">{jktDateTime(r.claimed_at)}</td>
              <td>
                {r.receipt_path ? <ReceiptViewer claimId={r.id} viewed={!!r.receipt_viewed_at} /> : <span className="text-xs text-ink-500">Tidak ada (klaim lama)</span>}
              </td>
              <td><Pill tone={st.tone}>{st.label}</Pill></td>
              <td>
                {r.status === 'pending' && !r.voided_at ? (
                  <ActionForm action={verifyBenefit} className="flex w-60 flex-col gap-1.5">
                    <input type="hidden" name="claim" value={r.id} />
                    <input name="note" placeholder="Catatan / alasan penolakan" className={inputCls} />
                    <div className="flex gap-1.5">
                      <SubmitButton name="decision" value="approve" variant="success" className="min-h-9 px-3">Setujui</SubmitButton>
                      <SubmitButton name="decision" value="reject" variant="danger" className="min-h-9 px-3">Tolak</SubmitButton>
                    </div>
                  </ActionForm>
                ) : (
                  <span className="text-xs text-ink-500">
                    {r.verified_at ? `${nameOf(profiles, r.verified_by ?? '')} · ${jktDateTime(r.verified_at)}` : ''}
                    {r.review_note ? ` · ${r.review_note}` : ''}
                    {r.voided_at ? ` · dibatalkan ${jktDateTime(r.voided_at)}` : ''}
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </Table>
      <Note>
        Setujui hanya setelah membuka bukti receipt (dicek ulang di server). Penolakan wajib beralasan; admin melihat alasannya dan bisa mengajukan ulang.
        Pengajuan yang ditolak tetap tersimpan, dan setiap perubahan status tercatat di audit log.
      </Note>
    </Card>
  )
}

/* ───────────── Jadwal ───────────── */
export async function ScheduleTab({ supabase, profiles }: Props) {
  const today = jktDate()
  const { data } = await supabase
    .from('schedule_templates')
    .select('id, admin_id, weekday, start_time, end_time, planned_break_minutes, effective_from, effective_to, change_note, created_at')
    .order('effective_from', { ascending: false })
  const rows = (data ?? []) as { id: number; admin_id: string; weekday: number; start_time: string; end_time: string; planned_break_minutes: number; effective_from: string; effective_to: string | null; change_note: string | null }[]
  const current = rows.filter((r) => r.effective_from <= today && (!r.effective_to || r.effective_to >= today))
  const upcoming = rows.filter((r) => r.effective_from > today)
  const t = (v: string) => v.slice(0, 5).replace(':', '.')
  const versions = [...new Map(rows.map((r) => [`${r.admin_id}|${r.effective_from}`, r])).values()]

  return (
    <>
      <Card title="Jadwal reguler yang berlaku hari ini">
        <Table head={['Admin', ...WEEKDAYS]}>
          {staffOf(profiles).filter((p) => p.is_active).map((p) => (
            <tr key={p.id}>
              <td className="font-semibold">{p.full_name}</td>
              {WEEKDAYS.map((_, i) => {
                const c = current.find((r) => r.admin_id === p.id && r.weekday === i + 1)
                return <td key={i}>{c ? <Pill tone="info">{t(c.start_time)}–{t(c.end_time)}</Pill> : <span className="text-ink-500">—</span>}</td>
              })}
            </tr>
          ))}
        </Table>
        {upcoming.length > 0 && <Note tone="warning">Ada {new Set(upcoming.map((u) => u.admin_id)).size} perubahan jadwal terjadwal yang belum berlaku.</Note>}
      </Card>

      <Card title="Ubah jadwal reguler">
        <ActionForm action={setSchedule} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Staf
            <select name="admin" className={inputCls}>
              {staffOf(profiles).filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Berlaku mulai
            <input type="date" name="from" required min={today} defaultValue={addDays(today, 1)} className={inputCls} />
          </label>
          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="mb-1.5 text-sm font-semibold">Hari kerja</legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((d, i) => (
                <label key={d} className="flex min-h-10 items-center gap-2 rounded-lg border border-[#dcd2bf] px-3 text-sm">
                  <input type="checkbox" name="weekday" value={i + 1} /> {d}
                </label>
              ))}
            </div>
          </fieldset>
          <label className={labelCls}>
            Mulai
            <input type="time" name="start" required defaultValue="08:00" className={inputCls} />
          </label>
          <label className={labelCls}>
            Selesai (boleh lewat tengah malam)
            <input type="time" name="end" required defaultValue="20:00" className={inputCls} />
          </label>
          <label className={labelCls}>
            Istirahat terencana (menit)
            <input name="break" inputMode="numeric" defaultValue="60" className={inputCls} />
          </label>
          <label className={labelCls}>
            Alasan perubahan
            <input name="note" required minLength={3} placeholder="Contoh: tukar hari dengan Dimas" className={inputCls} />
          </label>
          <div className="sm:col-span-2">
            <SubmitButton variant="accent">Simpan versi jadwal</SubmitButton>
          </div>
        </ActionForm>
        <Note>Jadwal lama ditutup sehari sebelum tanggal berlaku, tidak dihapus. Shift yang sudah dibuat tidak berubah otomatis.</Note>
      </Card>

      <Card title="Histori perubahan jadwal">
        <ul className="flex flex-col gap-1.5 text-sm">
          {versions.map((v) => {
            const days = rows.filter((r) => r.admin_id === v.admin_id && r.effective_from === v.effective_from)
            return (
              <li key={`${v.admin_id}-${v.effective_from}`}>
                <span className="font-semibold">{nameOf(profiles, v.admin_id)}</span> · {days.map((d) => WEEKDAYS[d.weekday - 1]).join(', ')} {t(v.start_time)}–{t(v.end_time)} ·
                berlaku {dateLabel(v.effective_from)}{v.effective_to ? ` s.d. ${dateLabel(v.effective_to)}` : ''}
                {v.change_note && <span className="text-ink-500"> · {v.change_note}</span>}
              </li>
            )
          })}
        </ul>
      </Card>
    </>
  )
}

/* ───────────── Aturan ───────────── */
export async function RulesTab({ supabase }: Props) {
  const [{ data: allowance }, { data: bonus }] = await Promise.all([
    supabase.from('allowance_rules').select('*').order('effective_from', { ascending: false }),
    supabase.from('bonus_rules').select('*').order('effective_from', { ascending: false }),
  ])
  const a = allowance?.[0]
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Uang saku pokok (shift reguler)">
        {a ? (
          <>
            <p className="text-sm">
              <b>{Number(a.target_hours)} jam bersih = {rupiah(a.amount_rp)}</b>, proporsional per jam bersih,{' '}
              {a.cap_at_target ? 'dibatasi maksimal target' : 'tidak dibatasi di atas target'}.
            </p>
            <p className="text-sm text-ink-500">
              Ditandai bila istirahat &gt; {a.suspicious_break_minutes} menit atau durasi &gt; {Number(a.suspicious_shift_hours)} jam. Berlaku sejak {jktDateTime(a.effective_from)}.
            </p>
          </>
        ) : (
          <Note tone="warning">Belum dikonfigurasi.</Note>
        )}
      </Card>

      <Card title="Aturan bonus shift tambahan">
        <Note tone="warning">Tarif di data uji adalah contoh. Isi tarif sebenarnya sebagai versi baru dengan tanggal berlaku.</Note>
        <ul className="flex flex-col gap-1 text-sm">
          {(bonus ?? []).map((b, i) => (
            <li key={b.id}>
              <b>v{(bonus?.length ?? 0) - i}</b> · {bonusRuleLabel(b)} · berlaku {jktDateTime(b.effective_from)}
              {i === 0 && <> <Pill tone="success">aktif</Pill></>}
            </li>
          ))}
        </ul>
        <ActionForm action={addBonusRule} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={`${labelCls} sm:col-span-2`}>
            Metode
            <select name="method" className={inputCls}>
              <option value="per_net_hour">Per jam bersih</option>
              <option value="fixed_per_shift">Tetap per shift</option>
              <option value="per_shift_type">Siang / malam per jam</option>
            </select>
          </label>
          <label className={labelCls}>Tarif per jam (Rp)<input name="per_hour_rp" inputMode="numeric" className={inputCls} /></label>
          <label className={labelCls}>Tetap per shift (Rp)<input name="fixed_rp" inputMode="numeric" className={inputCls} /></label>
          <label className={labelCls}>Siang per jam (Rp)<input name="day_per_hour_rp" inputMode="numeric" className={inputCls} /></label>
          <label className={labelCls}>Malam per jam (Rp)<input name="night_per_hour_rp" inputMode="numeric" className={inputCls} /></label>
          <label className={labelCls}>Berlaku mulai<input type="date" name="from" required defaultValue={addDays(jktDate(), 1)} className={inputCls} /></label>
          <div className="flex items-end"><SubmitButton variant="accent">Simpan versi aturan</SubmitButton></div>
        </ActionForm>
        <p className="text-xs text-ink-500">Isi kolom tarif sesuai metode; kolom lain diabaikan. Shift lama tetap memakai versi yang berlaku saat itu.</p>
      </Card>
    </div>
  )
}

/* ───────────── Akun staf ───────────── */
export async function StaffTab({ profiles }: Props) {
  return (
    <>
      <Card title="Akun staf">
        <Table head={['Username', 'Nama', 'Role', 'Status', 'Restock Panel', '']}>
          {profiles.map((p) => (
            <tr key={p.id}>
              <td className="font-mono text-[13px]">{p.username}</td>
              <td className="font-semibold">{p.full_name}</td>
              <td>{p.role === 'owner' ? 'Owner' : 'Staf'}</td>
              <td>
                <div className="flex flex-col items-start gap-1">
                  <Pill tone={p.is_active ? 'success' : 'neutral'}>{p.is_active ? 'Aktif' : 'Nonaktif'}</Pill>
                  {p.must_change_password && <Pill tone="warning">Wajib ganti password</Pill>}
                </div>
              </td>
              <td>
                {p.role === 'staff' ? (
                  <ActionForm action={setStaffPermission}>
                    <input type="hidden" name="profile" value={p.id} />
                    <input type="hidden" name="can" value={String(!p.can_restock_panel)} />
                    <SubmitButton variant="ghost" className="min-h-9 px-3">{p.can_restock_panel ? 'Diizinkan · cabut' : 'Tidak · izinkan'}</SubmitButton>
                  </ActionForm>
                ) : 'Selalu'}
              </td>
              <td>
                {p.role === 'staff' && (
                  <div className="flex flex-wrap gap-1.5">
                    <ActionForm action={setStaffActive} confirm={p.is_active ? `Nonaktifkan ${p.full_name}? Sesi login aktifnya langsung dicabut.` : undefined}>
                      <input type="hidden" name="profile" value={p.id} />
                      <input type="hidden" name="active" value={String(!p.is_active)} />
                      <SubmitButton variant={p.is_active ? 'danger' : 'ghost'} className="min-h-9 px-3">{p.is_active ? 'Nonaktifkan' : 'Aktifkan'}</SubmitButton>
                    </ActionForm>
                    <ActionForm action={resetPassword} confirm={`Reset password ${p.full_name}? Sesi lamanya dicabut.`} resultClassName="max-w-72 break-all">
                      <input type="hidden" name="profile" value={p.id} />
                      <SubmitButton variant="ghost" className="min-h-9 px-3">Reset password</SubmitButton>
                    </ActionForm>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
        <Note>Password tidak pernah ditampilkan. Reset membuat password sementara sekali tampil yang wajib diganti saat login berikutnya.</Note>
      </Card>

      <Card title="+ Tambah staf">
        <ActionForm action={createStaff} className="grid grid-cols-1 gap-3 sm:grid-cols-3" resultClassName="sm:col-span-3 break-all">
          <label className={labelCls}>Username<input name="username" required pattern="[a-z0-9_.]{3,32}" autoCapitalize="none" className={inputCls} /></label>
          <label className={labelCls}>Nama<input name="full_name" required className={inputCls} /></label>
          <div className="flex items-end"><SubmitButton variant="accent">Buat akun staf</SubmitButton></div>
        </ActionForm>
        <p className="text-xs text-ink-500">Akun baru selalu ber-role staf. Pendaftaran publik dimatikan.</p>
      </Card>
    </>
  )
}
