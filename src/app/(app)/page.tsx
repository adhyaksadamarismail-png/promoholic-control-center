import { createSessionClient } from '@/lib/supabase/server'

const STATUS: Record<string, string> = {
  scheduled: 'Belum absen masuk',
  in_progress: 'Sedang bekerja',
  completed: 'Selesai',
  incomplete: 'Absensi tidak lengkap',
  cancelled: 'Dibatalkan',
}

function jktToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date())
}
function jktTime(iso: string) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export default async function HomePage() {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  const [{ data: profile }, { data: shifts }] = await Promise.all([
    supabase.from('profiles').select('full_name, role').eq('id', auth.user!.id).single(),
    supabase
      .from('shifts')
      .select('id, code, kind, planned_start, planned_end, status, benefit_entitlements(benefit_claims(claimed_at, voided_at))')
      .eq('admin_id', auth.user!.id)
      .eq('shift_date', jktToday())
      .order('planned_start'),
  ])
  const today = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full' }).format(new Date())

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">{today}</span>
          <h1 className="font-display text-2xl font-bold">Halo, {profile?.full_name}</h1>
        </div>
        <form action="/api/auth/logout" method="post" className="md:hidden">
          <button className="min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Keluar</button>
        </form>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-5">
        <h2 className="font-display text-base font-semibold">Shift hari ini</h2>
        {!shifts?.length && <p className="text-sm text-ink-500">Tidak ada shift terjadwal hari ini.</p>}
        {shifts?.map((s) => {
          const claims = (s.benefit_entitlements as unknown as { benefit_claims: { claimed_at: string; voided_at: string | null }[] }[])
            ?.flatMap((e) => e.benefit_claims)
            .filter((c) => !c.voided_at)
          return (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-navy-900 p-4 text-white">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[#c5cbd9]">{s.code}</span>
                <span className="font-display text-lg font-semibold">
                  {s.kind === 'regular' ? 'Reguler' : 'Tambahan'} · {jktTime(s.planned_start)}–{jktTime(s.planned_end)}
                </span>
                <span className="text-sm text-[#c5cbd9]">
                  {STATUS[s.status] ?? s.status} · Benefit KopKen: {claims?.length ? 'sudah diambil' : 'belum diambil'}
                </span>
              </div>
            </div>
          )
        })}
      </section>

      <p className="text-sm text-ink-500">
        Fondasi aplikasi sudah aktif (login, sesi, peran). Halaman operasional dibangun bertahap mengikuti mockup yang sudah disetujui.
      </p>
    </div>
  )
}
