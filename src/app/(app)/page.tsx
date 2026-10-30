import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/auth'
import { Icon, type IconName } from '@/components/icons'
import { WEEKDAYS, addDays, dateLabel, isYmd, jktDate, jktTime, rupiah, weekStart } from '@/lib/format'
import { effectiveEvents, firstOf, type AttendanceEvent } from '@/lib/attendance'

export const dynamic = 'force-dynamic'

type Claim = { status: string; voided_at: string | null; claimed_at: string }
type Shift = {
  id: string
  code: string
  admin_id: string
  kind: 'regular' | 'extra'
  shift_date: string
  planned_start: string
  planned_end: string
  status: string
  attendance_events: AttendanceEvent[]
  benefit_entitlements: { benefit_claims: Claim[] } | { benefit_claims: Claim[] }[] | null
}
type Tone = 'neutral' | 'live' | 'done' | 'danger' | 'warning'

const TONE: Record<Tone, string> = {
  neutral: 'bg-white/10 text-[#dbe0ea]',
  live: 'bg-orange-500 text-navy-900',
  done: 'bg-[#e8f5ee] text-success-700',
  danger: 'bg-[#fde3df] text-danger-700',
  warning: 'bg-warning-100 text-warning-700',
}
const DOT: Record<Tone, string> = {
  neutral: 'text-[#c5cbd9]',
  live: 'text-orange-500',
  done: 'text-[#7fd6a6]',
  danger: 'text-[#ff9b8f]',
  warning: 'text-[#ffc46b]',
}

/** Status shift dari data absensi tersimpan — tidak ada status yang ditebak. */
function shiftState(s: Shift, now: number): { label: string; tone: Tone } {
  const hasIn = s.attendance_events?.some((e) => e.kind === 'clock_in')
  if (s.status === 'cancelled') return { label: 'Dibatalkan', tone: 'neutral' }
  if (s.status === 'completed') return { label: 'Selesai', tone: 'done' }
  if (s.status === 'in_progress') return { label: 'Sedang berlangsung', tone: 'live' }
  if (s.status === 'incomplete') return hasIn ? { label: 'Absensi tidak lengkap', tone: 'danger' } : { label: 'Tidak hadir', tone: 'danger' }
  if (Date.parse(s.planned_end) < now) return { label: 'Tidak hadir', tone: 'danger' }
  return { label: 'Belum dimulai', tone: 'neutral' }
}

function claimsOf(s: Shift) {
  const e = s.benefit_entitlements
  return (Array.isArray(e) ? e : e ? [e] : []).flatMap((x) => x.benefit_claims ?? []).filter((c) => !c.voided_at)
}
function benefitState(s: Shift): { label: string; tone: Tone } {
  const c = claimsOf(s)
  if (c.some((x) => x.status === 'verified')) return { label: 'Benefit KopKen: sudah diambil', tone: 'done' }
  if (c.some((x) => x.status === 'pending')) return { label: 'Benefit KopKen: menunggu verifikasi', tone: 'warning' }
  if (c.some((x) => x.status === 'rejected')) return { label: 'Benefit KopKen: ditolak, ajukan ulang', tone: 'danger' }
  if (s.status === 'cancelled') return { label: 'Benefit KopKen: tidak tersedia', tone: 'neutral' }
  const hasIn = s.attendance_events?.some((e) => e.kind === 'clock_in')
  return { label: hasIn ? 'Benefit KopKen: belum diajukan' : 'Benefit KopKen: tersedia setelah absen masuk', tone: 'neutral' }
}
function attendanceLine(s: Shift) {
  const eff = effectiveEvents(s.attendance_events ?? [])
  const inAt = firstOf(eff, 'clock_in')
  const outAt = firstOf(eff, 'clock_out')
  if (!inAt) return 'Masuk belum dicatat'
  return outAt ? `Masuk ${jktTime(inAt)} · Pulang ${jktTime(outAt)}` : `Masuk sudah dicatat · ${jktTime(inAt)}`
}

const card = 'rounded-2xl border border-cream-300 bg-white p-4 shadow-[0_1px_2px_rgba(21,35,66,0.05)] sm:p-5'

function SectionTitle({ title, href, link = 'Lihat semua' }: { title: string; href?: string; link?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-display text-base font-semibold">{title}</h2>
      {href && (
        <Link href={href} className="inline-flex min-h-8 items-center gap-0.5 text-sm font-semibold text-orange-700">
          {link} <Icon name="chevron" className="size-4" />
        </Link>
      )}
    </div>
  )
}

function ShiftCard({ s, now, href }: { s: Shift; now: number; href: string | null }) {
  const st = shiftState(s, now)
  const bf = benefitState(s)
  const hasIn = s.attendance_events?.some((e) => e.kind === 'clock_in')
  const body = (
    <div className="flex items-center gap-3 rounded-xl bg-navy-900 p-4 text-white">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs text-[#c5cbd9]">{s.code}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${TONE[st.tone]}`}>{st.label}</span>
        </div>
        <span className="font-display text-lg font-semibold">
          {s.kind === 'regular' ? 'Reguler' : 'Tambahan'} · {jktTime(s.planned_start)}–{jktTime(s.planned_end)}
        </span>
        <span className="flex items-center gap-2 text-sm text-[#dbe0ea]">
          <Icon name="clock" className={`size-4 shrink-0 ${DOT[hasIn ? 'done' : st.tone === 'danger' ? 'danger' : 'warning']}`} />
          {attendanceLine(s)}
        </span>
        <span className="flex items-center gap-2 text-sm text-[#dbe0ea]">
          <Icon name="coffee" className={`size-4 shrink-0 ${DOT[bf.tone]}`} />
          {bf.label}
        </span>
      </div>
      {href && <Icon name="chevron" className="size-5 shrink-0 text-[#c5cbd9]" />}
    </div>
  )
  return href ? (
    <Link href={href} aria-label={`Buka Absensi & Benefit untuk ${s.code}`} className="block rounded-xl focus-visible:outline-2 focus-visible:outline-orange-500">
      {body}
    </Link>
  ) : (
    body
  )
}

type Action = { href: string; title: string; desc: string; icon: IconName; tint: string; badge?: number }

function QuickAction({ a }: { a: Action }) {
  return (
    <Link href={a.href} className={`group flex min-h-[5.5rem] items-start gap-3 rounded-2xl border p-3.5 transition-colors ${a.tint}`}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-navy-900 shadow-sm">
        <Icon name={a.icon} className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-navy-900">
          {a.title}
          {!!a.badge && <span className="rounded-full bg-orange-500 px-1.5 text-[11px] font-bold text-navy-900">{a.badge}</span>}
        </span>
        <span className="text-xs leading-snug text-ink-500">{a.desc}</span>
      </span>
      <Icon name="chevron" className="mt-2.5 size-4 shrink-0 text-ink-500 transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

function Metric({ icon, value, label, sub }: { icon: IconName; value: React.ReactNode; label: string; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-cream-300 bg-white p-3.5">
      <span className="flex size-8 items-center justify-center rounded-lg bg-orange-100 text-orange-700">
        <Icon name={icon} className="size-4" />
      </span>
      <span className="mt-1 break-words font-display text-lg font-bold leading-tight sm:text-xl">{value}</span>
      <span className="text-xs font-semibold text-navy-900">{label}</span>
      {sub && <span className="text-[11px] leading-snug text-ink-500">{sub}</span>}
    </div>
  )
}

type Activity = { at: string; title: string; detail: string; icon: IconName; tint: string; status?: string }

const AUDIT: Record<string, { title: string; icon: IconName; tint: string }> = {
  'order.confirm': { title: 'Order dicatat', icon: 'cart', tint: 'bg-[#e8f5ee] text-success-700' },
  'order.draft': { title: 'Draft order dibuat', icon: 'cart', tint: 'bg-warning-100 text-warning-700' },
  'order.confirm_draft': { title: 'Draft dikonfirmasi', icon: 'cart', tint: 'bg-[#e8f5ee] text-success-700' },
  'order.cancel_draft': { title: 'Draft dibatalkan', icon: 'cart', tint: 'bg-[#eef0f4] text-ink-500' },
  'order.cancel_request': { title: 'Pembatalan order diajukan', icon: 'alert', tint: 'bg-warning-100 text-warning-700' },
  'account.create': { title: 'Akun baru ditambahkan', icon: 'user', tint: 'bg-navy-100 text-navy-700' },
  'restock.add_stock': { title: 'Restock voucher', icon: 'box', tint: 'bg-orange-100 text-orange-700' },
  'restock.extra_only': { title: 'Restock Baperan', icon: 'box', tint: 'bg-orange-100 text-orange-700' },
  'restock.bulk': { title: 'Bulk restock', icon: 'box', tint: 'bg-orange-100 text-orange-700' },
  'benefit.submit': { title: 'Benefit KopKen diajukan', icon: 'coffee', tint: 'bg-orange-100 text-orange-700' },
  'benefit.verify': { title: 'Benefit KopKen diverifikasi', icon: 'coffee', tint: 'bg-[#e8f5ee] text-success-700' },
  'benefit.reject': { title: 'Benefit KopKen ditolak', icon: 'coffee', tint: 'bg-danger-100 text-danger-700' },
  'approval.approve': { title: 'Pengajuan disetujui', icon: 'shield', tint: 'bg-[#e8f5ee] text-success-700' },
  'approval.reject': { title: 'Pengajuan ditolak', icon: 'shield', tint: 'bg-danger-100 text-danger-700' },
  'payroll.approve': { title: 'Rekap mingguan disetujui', icon: 'wallet', tint: 'bg-navy-100 text-navy-700' },
  'payroll.paid': { title: 'Uang saku dicairkan', icon: 'wallet', tint: 'bg-[#e8f5ee] text-success-700' },
  'shift.add_extra': { title: 'Shift tambahan dibuat', icon: 'calendar', tint: 'bg-navy-100 text-navy-700' },
  'schedule.set': { title: 'Jadwal diubah', icon: 'calendar', tint: 'bg-navy-100 text-navy-700' },
}

function auditDetail(action: string, after: Record<string, unknown> | null, actor: string) {
  const a = after ?? {}
  const parts: string[] = []
  for (const k of ['code', 'batch', 'restock', 'shift', 'voucher', 'payout']) if (typeof a[k] === 'string') parts.push(a[k] as string)
  if (typeof a.cup_size === 'string') parts.push(a.cup_size === 'large' ? 'Large' : 'Regular')
  if (typeof a.net_profit === 'number' && action.startsWith('order.')) parts.push(`laba ${rupiah(a.net_profit)}`)
  return [...parts, actor].join(' · ')
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase, userId: me, profile, isOwner } = viewer
  const sp = await searchParams
  const today = jktDate()
  const week = weekStart(today)
  const day = isYmd(sp.day) && sp.day >= week && sp.day <= addDays(week, 6) ? sp.day : today
  const now = Date.now()
  const todayStart = `${today}T00:00:00+07:00`
  const shiftCols =
    'id, code, admin_id, kind, shift_date, planned_start, planned_end, status, attendance_events(id, kind, at, corrects_id, correction_reason), benefit_entitlements(benefit_claims(status, voided_at, claimed_at))'
  const orderCols = 'code, sell_price, gross_profit, status, needs_review, created_at'


  // RLS tetap membatasi: staf hanya melihat shift, order, dan klaim miliknya sendiri.
  const shiftQ = supabase.from('shifts').select(shiftCols).gte('shift_date', week).lte('shift_date', addDays(week, 6))
  const orderQ = supabase.from('orders').select(orderCols).gte('created_at', todayStart)
  const [{ data: weekShifts }, { data: orders }, { data: names }] = await Promise.all([
    (isOwner ? shiftQ : shiftQ.eq('admin_id', me)).order('planned_start'),
    (isOwner ? orderQ : orderQ.eq('admin_id', me)).order('created_at', { ascending: false }),
    supabase.from('profiles').select('id, full_name'),
  ])
  const shifts = (weekShifts ?? []) as unknown as Shift[]
  const myToday = shifts.filter((s) => s.admin_id === me && s.shift_date === today)
  const nameOf = (id: string) => names?.find((n) => n.id === id)?.full_name ?? '—'
  const confirmed = (orders ?? []).filter((o) => o.status === 'confirmed')
  const omzet = confirmed.reduce((a, o) => a + Number(o.sell_price), 0)
  const gross = confirmed.reduce((a, o) => a + Number(o.gross_profit), 0)

  let ownerInfo: { approvals: number; benefits: number; earnings: number; used: number; review: number; accountsReview: number } | null = null
  let activities: Activity[] = []
  if (isOwner) {
    const [ap, bc, se, used, acc, audit] = await Promise.all([
      supabase.from('approval_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('benefit_claims').select('id', { count: 'exact', head: true }).eq('status', 'pending').is('voided_at', null),
      supabase.from('shift_earnings').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('stock_ledger').select('id', { count: 'exact', head: true }).eq('reason', 'use').gte('at', todayStart),
      supabase.from('accounts').select('id', { count: 'exact', head: true }).eq('needs_review', true),
      supabase.from('audit_log').select('id, action, after, actor_id, at').in('action', Object.keys(AUDIT)).order('at', { ascending: false }).limit(7),
    ])
    ownerInfo = {
      approvals: ap.count ?? 0,
      benefits: bc.count ?? 0,
      earnings: se.count ?? 0,
      used: used.count ?? 0,
      review: confirmed.filter((o) => o.needs_review).length,
      accountsReview: acc.count ?? 0,
    }
    activities = (audit.data ?? []).map((a) => ({
      at: a.at,
      ...AUDIT[a.action],
      detail: auditDetail(a.action, a.after as Record<string, unknown> | null, a.actor_id ? nameOf(a.actor_id) : 'Sistem'),
    }))
  } else {
    // Staf tidak membaca audit log; aktivitas disusun dari data miliknya sendiri.
    const [{ data: myOrders }, { data: myClaims }, { data: myRestocks }] = await Promise.all([
      supabase.from('orders').select('code, sell_price, status, created_at').eq('admin_id', me).order('created_at', { ascending: false }).limit(5),
      supabase.from('benefit_claims').select('claimed_at, status, cup_size, shifts(code)').eq('admin_id', me).order('claimed_at', { ascending: false }).limit(3),
      supabase.from('restocks').select('code, kind, items, created_at').eq('created_by', me).order('created_at', { ascending: false }).limit(3),
    ])
    const KIND: Record<string, string> = { clock_in: 'Absensi masuk', clock_out: 'Absensi pulang', break_start: 'Mulai istirahat', break_end: 'Selesai istirahat', off_start: 'Mulai Off/Izin', off_end: 'Selesai Off/Izin' }
    const STATUS: Record<string, string> = { pending: 'Menunggu verifikasi', verified: 'Terverifikasi', rejected: 'Ditolak', confirmed: 'Dikonfirmasi', draft: 'Draft', cancelled: 'Dibatalkan' }
    const events = shifts
      .filter((s) => s.admin_id === me)
      .flatMap((s) => (s.attendance_events ?? []).map((e) => ({ ...e, code: s.code })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 4)
    activities = [
      ...(myOrders ?? []).map((o) => ({
        at: o.created_at,
        title: o.status === 'draft' ? 'Draft order dibuat' : 'Order dicatat',
        detail: `${o.code} · ${rupiah(o.sell_price)}`,
        icon: 'cart' as const,
        tint: 'bg-[#e8f5ee] text-success-700',
        status: STATUS[o.status],
      })),
      ...(myClaims ?? []).map((c) => {
        const sh = (Array.isArray(c.shifts) ? c.shifts[0] : c.shifts) as { code: string } | null
        const cup = c.cup_size === 'large' ? 'Large' : c.cup_size === 'regular' ? 'Regular' : '—'
        return { at: c.claimed_at, title: 'Benefit KopKen diajukan', detail: `${sh?.code ?? ''} · ${cup}`, icon: 'coffee' as const, tint: 'bg-orange-100 text-orange-700', status: STATUS[c.status] }
      }),
      ...(myRestocks ?? []).map((r) => ({
        at: r.created_at,
        title: r.kind === 'new_account' ? 'Akun baru ditambahkan' : r.kind === 'extra_only' ? 'Restock Baperan' : 'Restock voucher',
        detail: `${r.code} · ${(r.items as { type: string; qty: number }[]).map((i) => `${i.type}×${i.qty}`).join(', ')}`,
        icon: 'box' as const,
        tint: 'bg-orange-100 text-orange-700',
      })),
      ...events.map((e) => ({ at: e.at, title: KIND[e.kind], detail: e.code, icon: 'check' as const, tint: 'bg-navy-100 text-navy-700' })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 7)
  }

  const navyTint = 'border-[#d6dcea] bg-navy-100/60 hover:bg-navy-100'
  const orangeTint = 'border-[#f5d8bd] bg-orange-100/70 hover:bg-orange-100'
  const actions: Action[] = isOwner
    ? [
        { href: '/finance', title: 'Keuangan', desc: 'Laba rugi, biaya & harga modal', icon: 'chart', tint: navyTint },
        { href: '/stock', title: 'Stok & Restock', desc: 'Cek stok dan riwayat restock', icon: 'box', tint: orangeTint },
        { href: '/approvals', title: 'Persetujuan', desc: 'Pembatalan, koreksi stok & absensi', icon: 'shield', tint: navyTint, badge: ownerInfo?.approvals },
        { href: '/owner/attendance?tab=benefit&status=pending', title: 'Absensi & Staf', desc: 'Uang saku, rekap & verifikasi benefit', icon: 'calendar', tint: orangeTint, badge: ownerInfo?.benefits },
        { href: '/panel', title: 'Panel Admin', desc: 'Restock akun & voucher', icon: 'settings', tint: navyTint },
        { href: '/vm', title: 'Virtual Machine', desc: 'Akun per device (khusus owner)', icon: 'monitor', tint: orangeTint },
      ]
    : [
        { href: '/attendance', title: 'Absensi & Benefit', desc: 'Catat absensi dan ajukan benefit KopKen', icon: 'calendar', tint: orangeTint },
        { href: '/orders/new', title: 'Catat Order', desc: 'Input transaksi order hari ini', icon: 'receipt', tint: navyTint },
        { href: '/accounts', title: 'Daftar Akun', desc: 'Lihat akun & voucher tersedia', icon: 'user', tint: 'border-cream-300 bg-white hover:bg-cream-50' },
      ]

  const dateLong = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full' }).format(new Date())
  const firstName = profile.full_name.split(' ')[0] ?? ''
  const dayShifts = shifts.filter((s) => s.shift_date === day && (isOwner || s.admin_id === me))
  const myState = myToday[0] ? shiftState(myToday[0], now) : null
  const pill = (t: Tone) => (t === 'neutral' ? 'bg-[#eef0f4] text-ink-500' : t === 'live' ? 'bg-orange-100 text-orange-700' : TONE[t])

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-sm text-ink-500">{dateLong}</span>
        <h1 className="font-display text-[1.75rem] font-bold leading-tight tracking-tight">Halo, {firstName}</h1>
        <p className="text-sm text-ink-500">
          {isOwner ? 'Ringkasan operasional Promo.Holic hari ini.' : myToday.length ? 'Semangat untuk shift hari ini!' : 'Tidak ada shift hari ini. Selamat beristirahat!'}
        </p>
      </header>

      {/* HP & tablet: satu kolom berurutan (order-*). Desktop lebar: dua kolom — kiri shift, aksi, jadwal; kanan ringkasan, aktivitas. */}
      <div className="flex flex-col gap-5 xl:grid xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] xl:items-start">
        <div className="contents xl:flex xl:flex-col xl:gap-5">
          <section className={`${card} order-1 flex flex-col gap-3`}>
            {isOwner && !myToday.length ? (
              <>
                <SectionTitle title="Perlu tindakan owner" href="/approvals" link="Persetujuan" />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    { href: '/owner/attendance?tab=benefit&status=pending', n: ownerInfo?.benefits ?? 0, label: 'Benefit menunggu verifikasi', icon: 'coffee' as const },
                    { href: '/approvals', n: ownerInfo?.approvals ?? 0, label: 'Pengajuan menunggu keputusan', icon: 'shield' as const },
                    { href: '/owner/attendance?tab=uang-saku', n: ownerInfo?.earnings ?? 0, label: 'Uang saku / bonus menunggu', icon: 'wallet' as const },
                  ].map((t) => (
                    <Link key={t.href} href={t.href} className="flex items-center gap-3 rounded-xl bg-navy-900 p-3.5 text-white">
                      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${t.n ? 'bg-orange-500 text-navy-900' : 'bg-white/10 text-[#c5cbd9]'}`}>
                        <Icon name={t.icon} className="size-5" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-display text-xl font-bold leading-none">{t.n}</span>
                        <span className="text-xs text-[#c5cbd9]">{t.label}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </>
            ) : (
              <>
                <SectionTitle title="Shift hari ini" href="/attendance" link="Absensi" />
                {myToday.length ? (
                  myToday.map((s) => <ShiftCard key={s.id} s={s} now={now} href="/attendance" />)
                ) : (
                  <p className="rounded-xl bg-cream-100 p-4 text-sm text-ink-500">Tidak ada shift terjadwal hari ini.</p>
                )}
              </>
            )}
          </section>

          <section className="order-2 flex flex-col gap-3">
            <SectionTitle title="Aksi cepat" />
            <div className={`grid grid-cols-1 gap-2.5 ${isOwner ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2' : 'sm:grid-cols-3'}`}>
              {actions.map((a) => (
                <QuickAction key={a.href} a={a} />
              ))}
            </div>
          </section>

          <section className={`${card} order-4 flex flex-col gap-3`}>
            <SectionTitle title={isOwner ? 'Jadwal tim minggu ini' : 'Jadwal minggu ini'} href={isOwner ? '/owner/attendance?tab=jadwal' : '/attendance'} />
            <nav aria-label="Pilih tanggal" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              {WEEKDAYS.map((w, i) => {
                const d = addDays(week, i)
                const has = shifts.some((s) => s.shift_date === d && (isOwner || s.admin_id === me))
                const active = d === day
                return (
                  <Link
                    key={d}
                    href={`/?day=${d}`}
                    scroll={false}
                    aria-current={active ? 'date' : undefined}
                    aria-label={`${dateLabel(d, 'long')}${has ? ', ada shift' : ''}`}
                    className={`flex min-h-14 min-w-[3.1rem] flex-1 flex-col items-center justify-center rounded-xl text-xs font-semibold ${active ? 'bg-navy-900 text-white' : 'bg-cream-100 text-ink-500'}`}
                  >
                    <span>{w}</span>
                    <span className={`font-display text-base ${active ? 'text-white' : 'text-navy-900'}`}>{Number(d.slice(8))}</span>
                    <span className={`mt-0.5 size-1.5 rounded-full ${has ? 'bg-orange-500' : 'bg-transparent'}`} />
                  </Link>
                )
              })}
            </nav>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold">{dateLabel(day, 'long')}</span>
              {!dayShifts.length && <p className="text-sm text-ink-500">Tidak ada shift pada tanggal ini.</p>}
              {dayShifts.map((s) => {
                const st = shiftState(s, now)
                return (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-300 px-3.5 py-2.5 text-sm">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold">
                        {isOwner && `${nameOf(s.admin_id)} · `}
                        {s.kind === 'regular' ? 'Reguler' : 'Tambahan'} · {jktTime(s.planned_start)}–{jktTime(s.planned_end)}
                      </span>
                      <span className="text-xs text-ink-500">
                        {attendanceLine(s)} · {benefitState(s).label.replace('Benefit KopKen: ', 'benefit ')}
                      </span>
                    </span>
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${pill(st.tone)}`}>{st.label}</span>
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        <div className="contents xl:flex xl:flex-col xl:gap-5">
          <section className={`${card} order-3 flex flex-col gap-3`}>
            <SectionTitle title={isOwner ? 'Ringkasan hari ini' : 'Ringkasan saya hari ini'} href={isOwner ? '/finance?p=day' : '/orders/new'} link={isOwner ? 'Keuangan' : 'Order saya'} />
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 xl:grid-cols-2">
              <Metric
                icon="cart"
                value={confirmed.length}
                label={isOwner ? 'Order' : 'Order saya'}
                sub={(orders ?? []).length > confirmed.length ? `+${(orders ?? []).length - confirmed.length} draft/batal` : 'terkonfirmasi'}
              />
              <Metric icon="wallet" value={rupiah(omzet)} label="Omzet" sub="harga jual order terkonfirmasi" />
              {isOwner ? (
                <>
                  <Metric icon="chart" value={rupiah(gross)} label="Laba kotor" sub={omzet ? `margin ${Math.round((gross / omzet) * 100)}% · bukan laba bersih` : 'bukan laba bersih'} />
                  <Metric icon="tag" value={ownerInfo?.used ?? 0} label="Voucher terpakai" sub="dari histori stok hari ini" />
                  <div className="col-span-2 lg:col-span-4 xl:col-span-2">
                    <Metric
                      icon="alert"
                      value={(ownerInfo?.review ?? 0) + (ownerInfo?.accountsReview ?? 0)}
                      label="Perlu diperiksa"
                      sub={`${ownerInfo?.review ?? 0} order hari ini ditandai · ${ownerInfo?.accountsReview ?? 0} akun ditandai`}
                    />
                  </div>
                </>
              ) : (
                <>
                  <Metric icon="tag" value={confirmed.length} label="Voucher dipakai" sub="satu voucher per order" />
                  <Metric icon="calendar" value={myState?.label ?? 'Tidak ada shift'} label="Absensi" sub={myToday[0] ? benefitState(myToday[0]).label : undefined} />
                </>
              )}
            </div>
          </section>

          <section className={`${card} order-5 flex flex-col gap-3`}>
            <SectionTitle title="Aktivitas terbaru" href={isOwner ? '/vouchers/history' : '/attendance'} />
            {!activities.length && (
              <p className="rounded-xl bg-cream-100 p-4 text-sm text-ink-500">
                {isOwner ? 'Belum ada aktivitas tercatat.' : 'Belum ada aktivitas Anda. Order, absensi, dan pengajuan benefit akan muncul di sini.'}
              </p>
            )}
            <ul className="flex flex-col divide-y divide-[#f1eadc]">
              {activities.map((a, i) => (
                <li key={i} className="flex items-start gap-3 py-2.5">
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${a.tint}`}>
                    <Icon name={a.icon} className="size-[18px]" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-semibold">{a.title}</span>
                    <span className="truncate text-xs text-ink-500">{a.detail}</span>
                    {a.status && <span className="text-[11px] font-semibold text-orange-700">{a.status}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-ink-500">{jktDate(a.at) === today ? jktTime(a.at) : dateLabel(jktDate(a.at))}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
