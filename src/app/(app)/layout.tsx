import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'

const STAFF_NAV = [
  { href: '/', label: 'Beranda' },
  { href: '/orders/new', label: 'Transaksi Order' },
  { href: '/accounts', label: 'Daftar Akun' },
  { href: '/vouchers/history', label: 'Riwayat Voucher' },
  { href: '/stock', label: 'Stok & Restock' },
  { href: '/panel', label: 'Panel Admin' },
  { href: '/attendance', label: 'Absensi & Benefit' },
]
const OWNER_NAV = [
  { href: '/finance', label: 'Keuangan' },
  { href: '/vm', label: 'Virtual Machine' },
  { href: '/settings/vouchers', label: 'Konfigurasi Voucher' },
  { href: '/owner/attendance', label: 'Absensi & Staf' },
  { href: '/approvals', label: 'Persetujuan' },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('full_name, role, is_active').eq('id', auth.user.id).single()
  if (!profile?.is_active) redirect('/login')
  const isOwner = profile.role === 'owner'

  return (
    <div className="flex min-h-screen flex-wrap">
      <aside className="flex flex-[1_1_100%] flex-col gap-4 bg-navy-900 px-3.5 py-5 text-[#c5cbd9] md:flex-[0_0_244px]">
        <div className="flex flex-col px-2 pb-2">
          <span className="font-display text-xl font-extrabold text-white">
            PROMO<span className="text-orange-500">HOLIC</span>
          </span>
          <span className="text-[11px] uppercase tracking-[0.08em] text-[#8790a6]">Control Center</span>
        </div>
        <nav aria-label="Navigasi utama" className="flex flex-row flex-wrap gap-0.5 md:flex-col">
          <span className="hidden px-2.5 pb-1.5 pt-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8790a6] md:block">Operasional</span>
          {STAFF_NAV.map((n) => (
            <Link key={n.href} href={n.href} className="flex min-h-10 items-center rounded-lg px-2.5 text-sm font-medium hover:bg-navy-800 hover:text-white">
              {n.label}
            </Link>
          ))}
          {isOwner && (
            <>
              <span className="hidden px-2.5 pb-1.5 pt-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#8790a6] md:block">Owner</span>
              {OWNER_NAV.map((n) => (
                <Link key={n.href} href={n.href} className="flex min-h-10 items-center rounded-lg px-2.5 text-sm font-medium hover:bg-navy-800 hover:text-white">
                  {n.label}
                </Link>
              ))}
            </>
          )}
        </nav>
        <div className="mt-auto hidden items-center justify-between gap-2 rounded-lg bg-navy-800 px-2.5 py-3 md:flex">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-white">{profile.full_name}</span>
            <span className="text-xs text-[#8790a6]">{isOwner ? 'Owner' : 'Staf'}</span>
          </div>
          <form action="/api/auth/logout" method="post">
            <button className="min-h-10 px-2 text-xs font-semibold text-[#c5cbd9] hover:text-white">Keluar</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-[999_1_560px] px-4 pb-12 pt-6 sm:px-8">{children}</main>
    </div>
  )
}
