import Link from 'next/link'
import { requireOwnerPage } from '@/lib/auth'
import { PageHeader, Stat, Tabs } from '@/components/ui'
import { addDays, dateLabel, isYmd, jktDate, weekStart } from '@/lib/format'
import { AttendanceTab, BenefitTab, EarningsTab, PayrollTab, RulesTab, ScheduleTab, StaffTab, type Profile } from './sections'

export const dynamic = 'force-dynamic'

const TABS = [
  { key: 'absensi', label: 'Absensi' },
  { key: 'uang-saku', label: 'Uang saku & bonus' },
  { key: 'rekap', label: 'Rekap mingguan' },
  { key: 'benefit', label: 'Benefit KopKen' },
  { key: 'jadwal', label: 'Jadwal' },
  { key: 'aturan', label: 'Aturan' },
  { key: 'staf', label: 'Akun staf' },
]

export default async function OwnerAttendancePage({ searchParams }: { searchParams: Promise<{ tab?: string; week?: string }> }) {
  const supabase = await requireOwnerPage()
  const sp = await searchParams
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : 'absensi'
  const week = isYmd(sp.week) ? weekStart(sp.week) : weekStart(jktDate())
  const end = addDays(week, 6)

  const [{ data: profiles }, { data: shifts }, { count: pendingEarnings }, { count: pendingApprovals }] = await Promise.all([
    supabase.from('profiles').select('id, username, full_name, role, is_active, can_restock_panel, must_change_password').order('role').order('username'),
    supabase.from('shifts').select('status, needs_review, benefit_entitlements(benefit_claims(voided_at))').gte('shift_date', week).lte('shift_date', end),
    supabase.from('shift_earnings').select('id, shifts!inner(shift_date)', { count: 'exact', head: true }).eq('status', 'pending').gte('shifts.shift_date', week).lte('shifts.shift_date', end),
    supabase.from('approval_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ])
  const list = shifts ?? []
  type Ent = { benefit_claims: { voided_at: string | null }[] }
  const claimed = list.filter((s) => {
    const e = s.benefit_entitlements as unknown as Ent | Ent[] | null
    return (Array.isArray(e) ? e : e ? [e] : []).some((x) => x.benefit_claims?.some((c) => !c.voided_at))
  }).length

  const href = (t: string, w = week) => `/owner/attendance?tab=${t}&week=${w}`
  const props = { supabase, week, profiles: (profiles ?? []) as Profile[] }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow={`Hanya owner · minggu ${dateLabel(week)} – ${dateLabel(end)}`} title="Absensi, Uang Saku & Staf">
        <Link href={href(tab, addDays(week, -7))} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-3.5 text-sm font-semibold">
          ← Minggu lalu
        </Link>
        <Link href={href(tab, weekStart(jktDate()))} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-3.5 text-sm font-semibold">
          Minggu ini
        </Link>
        <Link href={href(tab, addDays(week, 7))} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-3.5 text-sm font-semibold">
          Minggu depan →
        </Link>
      </PageHeader>

      <div className="flex flex-wrap gap-3">
        <Stat label="Shift minggu ini" value={list.length} sub={`${list.filter((s) => s.status === 'completed').length} selesai`} />
        <Stat label="Perlu diperiksa" value={list.filter((s) => s.needs_review || s.status === 'incomplete').length} sub="ditandai sistem" />
        <Stat label="Menunggu persetujuan" value={pendingEarnings ?? 0} sub="uang saku / bonus" />
        <Stat label="Benefit diambil" value={`${claimed} / ${list.length}`} sub="1 cup per shift" />
        <Stat label="Pengajuan koreksi" value={pendingApprovals ?? 0} sub={<Link href="/approvals" className="font-semibold text-orange-700">Buka Persetujuan</Link>} />
      </div>

      <Tabs items={TABS.map((t) => ({ ...t, href: href(t.key) }))} active={tab} />

      {tab === 'absensi' && <AttendanceTab {...props} />}
      {tab === 'uang-saku' && <EarningsTab {...props} />}
      {tab === 'rekap' && <PayrollTab {...props} />}
      {tab === 'benefit' && <BenefitTab {...props} />}
      {tab === 'jadwal' && <ScheduleTab {...props} />}
      {tab === 'aturan' && <RulesTab {...props} />}
      {tab === 'staf' && <StaffTab {...props} />}
    </div>
  )
}
