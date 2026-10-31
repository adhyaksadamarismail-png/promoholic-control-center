import { redirect } from 'next/navigation'
import { AutoRefresh } from '@/components/auto-refresh'
import { getViewer } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Stat, inputCls, labelCls } from '@/components/ui'
import { addDays, dateLabel, isoToJktLocal, jktDate, jktDateTime, jktTime, minutesLabel, rupiah, weekStart } from '@/lib/format'
import {
  ACTION_LABEL,
  EARNING_STATUS,
  KIND_LABEL,
  ABSENCE,
  SHIFT_STATUS,
  bonusRuleLabel,
  effectiveEvents,
  estimateAllowance,
  estimateBonus,
  firstOf,
  breakMinutes,
  missingRegularShifts,
  netMinutes,
  nextActions,
  offMinutes,
  workStatus,
  WORK_STATUS,
  type AbsenceKind,
  type AttendanceEvent,
  type AttendanceKind,
} from '@/lib/attendance'
import { attendanceAction, requestAttendanceFix, requestBenefitFix } from './actions'
import { BenefitForm } from './benefit-form'

export const dynamic = 'force-dynamic'

type Claim = {
  id: string
  claimed_at: string
  voided_at: string | null
  status: 'pending' | 'verified' | 'rejected'
  cup_size: string | null
  receipt_path: string | null
  review_note: string | null
  verified_at: string | null
}
const CUP: Record<string, string> = { regular: 'Regular', large: 'Large' }
const CLAIM_STATUS = {
  none: { label: 'Belum diajukan', tone: 'neutral' as const },
  pending: { label: 'Menunggu Verifikasi', tone: 'warning' as const },
  verified: { label: 'Terverifikasi · sudah diambil', tone: 'success' as const },
  rejected: { label: 'Ditolak', tone: 'danger' as const },
}
type Shift = {
  id: string
  code: string
  kind: 'regular' | 'extra'
  shift_date: string
  planned_start: string
  planned_end: string
  status: string
  absence_kind: AbsenceKind | null
  needs_review: boolean
  review_reasons: string[]
  attendance_events: AttendanceEvent[]
  benefit_entitlements: { id: string; benefit_claims: Claim[] } | null
  shift_earnings: { net_minutes: number; base_allowance: number; bonus: number; status: string } | null
}

// Relasi satu-ke-satu dikembalikan PostgREST sebagai objek; jaga-jaga bila berupa array.
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

export default async function AttendancePage() {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase, userId: me, profile, isOwner } = viewer
  if (isOwner) redirect('/owner/attendance') // halaman ini untuk absensi mandiri staf
  const today = jktDate()
  const week = weekStart(today)
  const nowIso = new Date().toISOString()

  const [{ data: rows }, { data: allowance }, { data: bonus }, { data: payrolls }, { data: pending }, { data: schedule }] = await Promise.all([
    supabase
      .from('shifts')
      .select(
        'id, code, kind, shift_date, planned_start, planned_end, status, absence_kind, needs_review, review_reasons, attendance_events(id, kind, at, corrects_id, correction_reason, actor_id), benefit_entitlements(id, benefit_claims(id, claimed_at, voided_at, status, cup_size, receipt_path, review_note, verified_at)), shift_earnings(net_minutes, base_allowance, bonus, status)',
      )
      .eq('admin_id', me)
      .gte('shift_date', addDays(week, -14))
      .lte('shift_date', addDays(today, 1))
      .order('planned_start', { ascending: false }),
    supabase.from('allowance_rules').select('target_hours, amount_rp, cap_at_target').lte('effective_from', nowIso).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('bonus_rules').select('method, fixed_rp, per_hour_rp, day_per_hour_rp, night_per_hour_rp').lte('effective_from', nowIso).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('weekly_payrolls').select('id, period_start, period_end, status, approved_total, payouts(code, paid_at, amount)').eq('admin_id', me).order('period_start', { ascending: false }).limit(4),
    supabase.from('approval_requests').select('id, kind, target_id, reason, requested_at').eq('requested_by', me).eq('status', 'pending'),
    // RLS: staf hanya membaca jadwal reguler miliknya.
    supabase.from('schedule_templates').select('admin_id, weekday, start_time, end_time, effective_from, effective_to')
      .eq('admin_id', me).lte('effective_from', addDays(today, 1)).or(`effective_to.is.null,effective_to.gte.${today}`),
  ])

  const shifts = ((rows ?? []) as unknown as Shift[]).map((s) => ({
    ...s,
    benefit_entitlements: one(s.benefit_entitlements),
    shift_earnings: one(s.shift_earnings),
  }))
  const now = Date.now()
  const active = shifts
    .filter(
      (s) =>
        s.status === 'in_progress' ||
        s.shift_date === today ||
        (s.status === 'scheduled' && Date.parse(s.planned_end) > now && Date.parse(s.planned_start) < now + 18 * 3600_000),
    )
    .reverse()
  const thisWeek = shifts.filter((s) => s.shift_date >= week && s.shift_date <= addDays(week, 6))
  // Jadwal reguler hari ini/besok yang belum dibuat owner sebagai shift: tidak bisa diabsen, jadi diberi tahu dengan jelas.
  const mine = shifts.map((s) => ({ ...s, admin_id: me }))
  const unscheduled = [week, addDays(week, 7)]
    .flatMap((w) => missingRegularShifts(schedule ?? [], mine, w))
    .filter((m) => m.date === today || m.date === addDays(today, 1))
    .sort((a, b) => a.date.localeCompare(b.date))
  const history = shifts.filter((s) => !active.includes(s) && Date.parse(s.planned_start) < now)
  const pendingTargets = new Set((pending ?? []).map((p) => p.target_id))

  const wkBase = thisWeek.reduce((a, s) => a + Number(s.shift_earnings?.base_allowance ?? 0), 0)
  const wkBonus = thisWeek.reduce((a, s) => a + Number(s.shift_earnings?.bonus ?? 0), 0)
  const wkRegular = thisWeek.filter((s) => s.kind === 'regular' && s.status !== 'cancelled')
  const wkPending = thisWeek.some((s) => s.shift_earnings?.status === 'pending')
  const currentPayroll = payrolls?.find((p) => p.period_start === week)
  const lastPayroll = payrolls?.find((p) => p.period_start < week)
  const lastPayout = one(lastPayroll?.payouts as { code: string; paid_at: string; amount: number }[] | null)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <AutoRefresh />
      <PageHeader eyebrow={`${profile.full_name} · ${dateLabel(today, 'long')}`} title="Absensi & Benefit" />

      {unscheduled.length > 0 && (
        <Note tone="warning">
          Jadwal reguler {unscheduled.map((m) => `${m.date === today ? 'hari ini' : 'besok'} ${m.start_time.slice(0, 5)}–${m.end_time.slice(0, 5)}`).join(' dan ')} sudah
          ada, tetapi shift-nya belum dibuat owner sehingga belum bisa diabsen. Minta owner menekan &quot;Buat shift reguler minggu ini&quot; di Absensi &amp; Staf.
        </Note>
      )}
      {!active.length && !unscheduled.length && (
        <Card>
          <p className="text-sm text-ink-500">Tidak ada shift aktif atau terjadwal dalam 18 jam ke depan.</p>
        </Card>
      )}

      {active.map((s) => {
        const eff = effectiveEvents(s.attendance_events ?? [])
        const next = s.status === 'scheduled' || s.status === 'in_progress' ? nextActions(eff) : []
        const net = netMinutes(eff, now)
        const brk = breakMinutes(eff, now)
        const off = offMinutes(eff, now)
        const ws = workStatus(eff)
        // Perubahan status oleh owner (pelaku bukan admin ini), ditampilkan apa adanya beserta alasannya.
        const byOwner = eff.filter((e) => e.actor_id && e.actor_id !== me)
        const est = s.kind === 'regular' ? estimateAllowance(net, allowance) : estimateBonus(net, bonus)
        // Klaim terbaru yang belum dibatalkan; "aktif" = menunggu verifikasi atau terverifikasi.
        const claims = (s.benefit_entitlements?.benefit_claims ?? []).filter((c) => !c.voided_at).sort((a, b) => b.claimed_at.localeCompare(a.claimed_at))
        const active = claims.find((c) => c.status === 'pending' || c.status === 'verified')
        const shown = active ?? claims[0]
        const claimState = CLAIM_STATUS[active?.status ?? (shown?.status === 'rejected' ? 'rejected' : 'none')]
        const hasIn = !!firstOf(eff, 'clock_in')
        const opensAt = Date.parse(s.planned_start) - 2 * 3600_000
        const target = allowance ? Number(allowance.target_hours) * 60 : 720
        const steps: AttendanceKind[] = ['clock_in', 'break_start', 'break_end', 'clock_out']
        return (
          <div key={s.id} className="flex flex-col gap-4">
            <section className="flex flex-col gap-4 rounded-2xl bg-navy-900 p-5 text-white">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-[#c5cbd9]">{s.code}</span>
                  <span className="font-display text-lg font-semibold">
                    {s.kind === 'regular' ? 'Shift reguler' : 'Shift tambahan'} · {jktTime(s.planned_start)}–{jktTime(s.planned_end)}
                  </span>
                  <span className="text-sm text-[#c5cbd9]">{dateLabel(s.shift_date, 'long')}</span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Pill tone={s.kind === 'regular' ? 'info' : 'orange'}>{s.kind === 'regular' ? 'Reguler' : 'Tambahan'}</Pill>
                  {ws.status !== 'belum' && <Pill tone={WORK_STATUS[ws.status].tone}>{WORK_STATUS[ws.status].label}{ws.since ? ` · ${jktTime(ws.since)}` : ''}</Pill>}
                </div>
              </div>
              {ws.status === 'off' && (
                <p className="rounded-lg bg-navy-800 px-3 py-2 text-sm">
                  Status Off/Izin diatur owner sejak {jktTime(ws.since)}. Waktu ini tidak dihitung sebagai jam kerja; minta owner bila sudah kembali bekerja.
                </p>
              )}

              <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {steps.map((k) => {
                  const at = k === 'break_start' || k === 'break_end' ? eff.filter((e) => e.kind === k).at(-1)?.at : firstOf(eff, k)
                  return (
                    <li key={k} className={`flex flex-col gap-0.5 rounded-xl px-3 py-2 ${at ? 'bg-navy-700' : 'bg-navy-800'}`}>
                      <span className="text-xs text-[#c5cbd9]">{KIND_LABEL[k]}</span>
                      <span className="font-display text-base font-semibold">{at ? jktTime(at) : '—'}</span>
                    </li>
                  )
                })}
              </ol>

              <div className="flex flex-col gap-1">
                <span className="font-display text-3xl font-bold">{minutesLabel(net)}</span>
                <span className="text-sm text-[#c5cbd9]">
                  kerja bersih{brk ? ` (istirahat ${minutesLabel(brk)})` : ''}{off ? ` · Off/Izin ${minutesLabel(off)}` : ''}
                  {s.kind === 'regular' && ` · target ${minutesLabel(target)} · tercapai ${Math.min(100, Math.round((net / target) * 100))}%`}
                </span>
              </div>

              {s.absence_kind && <Pill tone={ABSENCE[s.absence_kind].tone}>Tercatat {ABSENCE[s.absence_kind].label} untuk shift ini</Pill>}
              {s.status === 'completed' && <Pill tone="success">Shift selesai</Pill>}
              {s.status === 'incomplete' && <Pill tone="danger">Absensi tidak lengkap — ajukan koreksi ke owner</Pill>}
              {next.length > 0 && (
                <ActionForm action={attendanceAction} className="flex flex-col gap-2">
                  <input type="hidden" name="shift" value={s.id} />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {next.map((k, i) => (
                      <SubmitButton
                        key={k}
                        name="kind"
                        value={k}
                        variant={i === 0 ? 'accent' : 'ghost'}
                        className="min-h-14 flex-1 text-base"
                        pendingText="Mencatat…"
                      >
                        {ACTION_LABEL[k]}
                      </SubmitButton>
                    ))}
                  </div>
                  {next[0] === 'clock_in' && now < opensAt && (
                    <span className="text-xs text-[#c5cbd9]">Absen masuk dibuka mulai {jktTime(new Date(opensAt).toISOString())}.</span>
                  )}
                </ActionForm>
              )}
              {byOwner.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs text-[#c5cbd9]">
                  {byOwner.map((e) => (
                    <li key={e.id}>Diubah owner: {KIND_LABEL[e.kind]} {jktTime(e.at)}{e.correction_reason ? ` — ${e.correction_reason}` : ''}</li>
                  ))}
                </ul>
              )}
              <span className="text-xs text-[#c5cbd9]">
                Waktu diambil dari server. Tombol muncul sesuai urutan; absen masuk/pulang tidak bisa dua kali.
              </span>
            </section>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Card title={s.kind === 'regular' ? 'Estimasi uang saku' : 'Estimasi bonus shift tambahan'}>
                <span className="font-display text-2xl font-bold">{est === null ? 'Belum dikonfigurasi' : rupiah(est)}</span>
                <span className="text-sm text-ink-500">
                  {s.kind === 'regular'
                    ? allowance
                      ? `${minutesLabel(net)} ÷ ${Number(allowance.target_hours)} j × ${rupiah(allowance.amount_rp)}`
                      : 'Aturan uang saku belum diisi owner.'
                    : `Aturan: ${bonusRuleLabel(bonus)}`}
                </span>
                <Note>
                  {s.shift_earnings
                    ? `Nilai tercatat ${rupiah(s.kind === 'regular' ? s.shift_earnings.base_allowance : s.shift_earnings.bonus)} · ${EARNING_STATUS[s.shift_earnings.status]?.label}.`
                    : 'Perkiraan saja. Nilai resmi dihitung server saat absen pulang dan disetujui owner.'}
                </Note>
              </Card>

              <Card title="Benefit KopKen shift ini" aside={<Pill tone={claimState.tone}>{claimState.label}</Pill>}>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-500">Hak</span>
                  <span className="font-semibold">1 cup · {s.code} · {dateLabel(s.shift_date)}</span>
                </div>
                {shown && (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Ukuran</span>
                      <span className="font-semibold">{CUP[shown.cup_size ?? ''] ?? '—'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Diajukan</span>
                      <span className="font-semibold">{jktDateTime(shown.claimed_at)} · {profile.full_name}</span>
                    </div>
                    {shown.receipt_path && (
                      <a href={`/api/benefit-receipt/${shown.id}`} target="_blank" rel="noopener" className="inline-flex min-h-8 items-center text-sm font-semibold text-orange-700">
                        Lihat bukti receipt
                      </a>
                    )}
                    {shown.status === 'rejected' && (
                      <Note tone="warning">Ditolak owner: {shown.review_note}. Perbaiki lalu ajukan ulang; pengajuan lama tetap tercatat.</Note>
                    )}
                    {shown.status === 'verified' && shown.verified_at && (
                      <span className="text-xs text-ink-500">Diverifikasi owner {jktDateTime(shown.verified_at)}{shown.review_note ? ` · ${shown.review_note}` : ''}</span>
                    )}
                  </>
                )}
                {active && (pendingTargets.has(active.id) ? (
                  <Note tone="warning">Pengajuan pembatalan klaim sedang menunggu owner.</Note>
                ) : (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-semibold text-orange-700">Salah catat? Ajukan pembatalan klaim</summary>
                    <ActionForm action={requestBenefitFix} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="claim" value={active.id} />
                      <label className={labelCls}>
                        Alasan
                        <input name="reason" required minLength={3} className={inputCls} placeholder="Contoh: salah pilih ukuran" />
                      </label>
                      <SubmitButton variant="ghost">Kirim ke owner</SubmitButton>
                    </ActionForm>
                  </details>
                ))}
                {!active && hasIn && s.status !== 'cancelled' && (
                  <BenefitForm shiftId={s.id} shiftCode={s.code} shiftDate={dateLabel(s.shift_date)} resubmit={shown?.status === 'rejected'} />
                )}
                {!active && !hasIn && (
                  <button disabled className="min-h-12 rounded-lg bg-[#e7e2d8] text-sm font-semibold text-[#6e7689]">
                    Bisa diajukan setelah absen masuk
                  </button>
                )}
                <span className="text-xs text-ink-500">
                  Pengajuan tercatat atas nama akun yang sedang login. Benefit dihitung sudah diambil setelah owner memverifikasi bukti.
                </span>
              </Card>
            </div>

            {hasIn && (
              <details className="rounded-2xl border border-cream-300 bg-white p-4 text-sm">
                <summary className="cursor-pointer font-semibold">Lupa absen atau jam salah? Ajukan koreksi ke owner</summary>
                {pendingTargets.has(s.id) ? (
                  <Note tone="warning">Pengajuan koreksi untuk shift ini sedang menunggu owner.</Note>
                ) : (
                  <ActionForm action={requestAttendanceFix} className="mt-3 grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="shift" value={s.id} />
                    <label className={labelCls}>
                      Bagian
                      <select name="kind" className={inputCls} defaultValue={s.status === 'incomplete' ? 'clock_out' : 'clock_in'}>
                        {steps.map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={labelCls}>
                      Waktu yang benar (WIB)
                      <input name="at" type="datetime-local" required className={inputCls} defaultValue={isoToJktLocal(s.planned_end)} />
                    </label>
                    <label className={`${labelCls} sm:col-span-2`}>
                      Alasan
                      <input name="reason" required minLength={3} className={inputCls} placeholder="Contoh: HP mati saat jam pulang" />
                    </label>
                    <div className="sm:col-span-2">
                      <SubmitButton variant="ghost">Kirim pengajuan</SubmitButton>
                    </div>
                  </ActionForm>
                )}
                <p className="mt-2 text-xs text-ink-500">Admin tidak bisa mengubah waktu absensi sendiri. Owner meninjau dan semua koreksi tercatat di audit log.</p>
              </details>
            )}
          </div>
        )
      })}

      <Card title="Minggu ini" aside={<span className="text-sm text-ink-500">{dateLabel(week)} – {dateLabel(addDays(week, 6))}</span>}>
        <div className="flex flex-wrap gap-3">
          <Stat
            label="Uang saku pokok"
            value={rupiah(wkBase)}
            sub={`${wkRegular.filter((s) => s.shift_earnings).length} dari ${wkRegular.length} shift reguler tercatat`}
          />
          <Stat label="Bonus tambahan" value={rupiah(wkBonus)} sub={`${thisWeek.filter((s) => s.kind === 'extra').length} shift tambahan`} />
          <Stat
            label="Total estimasi"
            value={rupiah(currentPayroll?.approved_total ?? wkBase + wkBonus)}
            sub={
              currentPayroll?.status === 'paid'
                ? 'Sudah dicairkan'
                : currentPayroll?.status === 'approved'
                  ? 'Disetujui owner, menunggu pencairan'
                  : wkPending
                    ? 'Sebagian menunggu persetujuan'
                    : 'Belum direkap owner'
            }
          />
        </div>
        {lastPayroll && (
          <Note>
            Minggu lalu ({dateLabel(lastPayroll.period_start)}–{dateLabel(lastPayroll.period_end)}):{' '}
            {lastPayout
              ? `dibayar ${jktDateTime(lastPayout.paid_at)} · ${rupiah(lastPayout.amount)} (${lastPayout.code})`
              : lastPayroll.status === 'approved'
                ? `disetujui ${rupiah(lastPayroll.approved_total)}, menunggu pencairan`
                : 'belum disetujui'}
          </Note>
        )}
      </Card>

      <Card title="Riwayat absensi & benefit">
        {!history.length && <p className="text-sm text-ink-500">Belum ada riwayat.</p>}
        <ul className="flex flex-col divide-y divide-[#f1eadc]">
          {history.map((s) => {
            const eff = effectiveEvents(s.attendance_events ?? [])
            const st = s.absence_kind ? ABSENCE[s.absence_kind] : s.status === 'scheduled' ? { label: 'Tidak absen', tone: 'warning' as const } : SHIFT_STATUS[s.status]
            const e = s.shift_earnings
            if (!eff.length)
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <span className="font-semibold">
                    {dateLabel(s.shift_date)} · {s.kind === 'regular' ? 'Reguler' : 'Tambahan'}{' '}
                    <span className="font-normal text-ink-500">
                      {jktTime(s.planned_start)}–{jktTime(s.planned_end)} · tidak ada absensi
                    </span>
                  </span>
                  {st && <Pill tone={st.tone}>{st.label}</Pill>}
                </li>
              )
            const cl = (s.benefit_entitlements?.benefit_claims ?? []).filter((c) => !c.voided_at)
            const claimed = cl.some((c) => c.status === 'verified') ? 'diambil' : cl.some((c) => c.status === 'pending') ? 'menunggu verifikasi' : cl.length ? 'ditolak' : 'tidak'
            const corrected = (s.attendance_events ?? []).some((x) => x.corrects_id)
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span className="font-semibold">
                    {dateLabel(s.shift_date)} · {s.kind === 'regular' ? 'Reguler' : 'Tambahan'}
                  </span>
                  <span className="text-ink-500">
                    {jktTime(firstOf(eff, 'clock_in'))}–{jktTime(firstOf(eff, 'clock_out'))} · {minutesLabel(e?.net_minutes ?? null)} ·{' '}
                    {e ? rupiah(s.kind === 'regular' ? e.base_allowance : e.bonus) : '—'} · KopKen: {claimed}
                    {corrected && ' · dikoreksi owner'}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {e && <Pill tone={EARNING_STATUS[e.status]?.tone}>{EARNING_STATUS[e.status]?.label}</Pill>}
                  {st && <Pill tone={st.tone}>{st.label}</Pill>}
                </div>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}
