import { createSessionClient } from '@/lib/supabase/server'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Stat, inputCls, labelCls } from '@/components/ui'
import { addDays, dateLabel, isoToJktLocal, jktDate, jktDateTime, jktTime, minutesLabel, rupiah, weekStart } from '@/lib/format'
import {
  ACTION_LABEL,
  EARNING_STATUS,
  KIND_LABEL,
  SHIFT_STATUS,
  bonusRuleLabel,
  effectiveEvents,
  estimateAllowance,
  estimateBonus,
  firstOf,
  breakMinutes,
  netMinutes,
  nextActions,
  type AttendanceEvent,
  type AttendanceKind,
} from '@/lib/attendance'
import { attendanceAction, claimBenefit, requestAttendanceFix, requestBenefitFix } from './actions'

export const dynamic = 'force-dynamic'

type Claim = { id: string; claimed_at: string; voided_at: string | null }
type Shift = {
  id: string
  code: string
  kind: 'regular' | 'extra'
  shift_date: string
  planned_start: string
  planned_end: string
  status: string
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
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  const me = auth.user!.id
  const today = jktDate()
  const week = weekStart(today)
  const nowIso = new Date().toISOString()

  const [{ data: profile }, { data: rows }, { data: allowance }, { data: bonus }, { data: payrolls }, { data: pending }] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', me).single(),
    supabase
      .from('shifts')
      .select(
        'id, code, kind, shift_date, planned_start, planned_end, status, needs_review, review_reasons, attendance_events(id, kind, at, corrects_id, correction_reason), benefit_entitlements(id, benefit_claims(id, claimed_at, voided_at)), shift_earnings(net_minutes, base_allowance, bonus, status)',
      )
      .eq('admin_id', me)
      .gte('shift_date', addDays(week, -14))
      .lte('shift_date', addDays(today, 1))
      .order('planned_start', { ascending: false }),
    supabase.from('allowance_rules').select('target_hours, amount_rp, cap_at_target').lte('effective_from', nowIso).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('bonus_rules').select('method, fixed_rp, per_hour_rp, day_per_hour_rp, night_per_hour_rp').lte('effective_from', nowIso).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('weekly_payrolls').select('id, period_start, period_end, status, approved_total, payouts(code, paid_at, amount)').eq('admin_id', me).order('period_start', { ascending: false }).limit(4),
    supabase.from('approval_requests').select('id, kind, target_id, reason, requested_at').eq('requested_by', me).eq('status', 'pending'),
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
      <PageHeader eyebrow={`${profile?.full_name} · ${dateLabel(today, 'long')}`} title="Absensi & Benefit" />

      {!active.length && (
        <Card>
          <p className="text-sm text-ink-500">Tidak ada shift aktif atau terjadwal dalam 18 jam ke depan.</p>
        </Card>
      )}

      {active.map((s) => {
        const eff = effectiveEvents(s.attendance_events ?? [])
        const next = s.status === 'scheduled' || s.status === 'in_progress' ? nextActions(eff) : []
        const net = netMinutes(eff, now)
        const brk = breakMinutes(eff, now)
        const est = s.kind === 'regular' ? estimateAllowance(net, allowance) : estimateBonus(net, bonus)
        const claims = (s.benefit_entitlements?.benefit_claims ?? []).filter((c) => !c.voided_at)
        const claim = claims[0]
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
                <Pill tone={s.kind === 'regular' ? 'info' : 'orange'}>{s.kind === 'regular' ? 'Reguler' : 'Tambahan'}</Pill>
              </div>

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
                  kerja bersih{brk ? ` (istirahat ${minutesLabel(brk)})` : ''}
                  {s.kind === 'regular' && ` · target ${minutesLabel(target)} · tercapai ${Math.min(100, Math.round((net / target) * 100))}%`}
                </span>
              </div>

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
              <span className="text-xs text-[#c5cbd9]">
                Waktu diambil dari server. Tombol muncul sesuai urutan; absen masuk/pulang tidak bisa dua kali.
              </span>
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
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

              <Card title="Benefit KopKen shift ini" aside={<Pill tone={claim ? 'success' : 'neutral'}>{claim ? 'Sudah diambil' : 'Belum diambil'}</Pill>}>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-500">Hak</span>
                  <span className="font-semibold">1 cup · {s.code}</span>
                </div>
                {claim ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Diambil</span>
                      <span className="font-semibold">{jktDateTime(claim.claimed_at)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-ink-500">Dicatat oleh</span>
                      <span className="font-semibold">{profile?.full_name} (sesi login)</span>
                    </div>
                    {pendingTargets.has(claim.id) ? (
                      <Note tone="warning">Pengajuan pembatalan klaim sedang menunggu owner.</Note>
                    ) : (
                      <details className="text-sm">
                        <summary className="cursor-pointer font-semibold text-orange-700">Salah catat? Ajukan koreksi</summary>
                        <ActionForm action={requestBenefitFix} className="mt-2 flex flex-col gap-2">
                          <input type="hidden" name="claim" value={claim.id} />
                          <label className={labelCls}>
                            Alasan
                            <input name="reason" required minLength={3} className={inputCls} placeholder="Contoh: tertekan tanpa sengaja" />
                          </label>
                          <SubmitButton variant="ghost">Kirim ke owner</SubmitButton>
                        </ActionForm>
                      </details>
                    )}
                  </>
                ) : (
                  <ActionForm action={claimBenefit} className="flex flex-col gap-2">
                    <input type="hidden" name="shift" value={s.id} />
                    {hasIn ? (
                      <SubmitButton variant="primary" className="min-h-12" pendingText="Mencatat…">
                        Ambil 1 cup KopKen
                      </SubmitButton>
                    ) : (
                      <button disabled className="min-h-12 rounded-lg bg-[#e7e2d8] text-sm font-semibold text-[#6e7689]">
                        Bisa diambil setelah absen masuk
                      </button>
                    )}
                  </ActionForm>
                )}
                <span className="text-xs text-ink-500">
                  Klaim tercatat atas nama akun yang sedang login. Klaim kedua untuk shift yang sama ditolak database.
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
            const st = s.status === 'scheduled' ? { label: 'Tidak absen', tone: 'warning' as const } : SHIFT_STATUS[s.status]
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
            const claimed = (s.benefit_entitlements?.benefit_claims ?? []).some((c) => !c.voided_at)
            const corrected = (s.attendance_events ?? []).some((x) => x.corrects_id)
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span className="font-semibold">
                    {dateLabel(s.shift_date)} · {s.kind === 'regular' ? 'Reguler' : 'Tambahan'}
                  </span>
                  <span className="text-ink-500">
                    {jktTime(firstOf(eff, 'clock_in'))}–{jktTime(firstOf(eff, 'clock_out'))} · {minutesLabel(e?.net_minutes ?? null)} ·{' '}
                    {e ? rupiah(s.kind === 'regular' ? e.base_allowance : e.bonus) : '—'} · KopKen: {claimed ? 'diambil' : 'tidak'}
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
