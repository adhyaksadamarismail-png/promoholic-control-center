import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'
import { MobileNav, SideNav } from './nav'

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
  const { data: profile } = await supabase.from('profiles').select('full_name, role, is_active, must_change_password').eq('id', auth.user.id).single()
  if (!profile?.is_active) redirect('/login')
  if (profile.must_change_password) redirect('/account/password')
  const isOwner = profile.role === 'owner'
  const roleLabel = isOwner ? 'Owner' : 'Staf'
  const logo = (
    <span className="flex flex-col">
      <span className="font-display text-xl font-extrabold text-white">
        PROMO<span className="text-orange-500">HOLIC</span>
      </span>
      <span className="text-[11px] uppercase tracking-[0.08em] text-[#8790a6]">Control Center</span>
    </span>
  )

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* HP: header ringkas, menu lipat dengan backdrop, dan bilah tab bawah (disembunyikan saat menu terbuka). */}
      <MobileNav logo={logo} staff={STAFF_NAV} owner={isOwner ? OWNER_NAV : null} name={profile.full_name} role={roleLabel} />

      <aside className="hidden flex-[0_0_244px] flex-col gap-4 bg-navy-900 px-3.5 py-5 text-[#c5cbd9] md:flex">
        <div className="px-2 pb-2">{logo}</div>
        <SideNav staff={STAFF_NAV} owner={isOwner ? OWNER_NAV : null} />
        <div className="mt-auto flex items-center justify-between gap-2 rounded-lg bg-navy-800 px-2.5 py-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-white">{profile.full_name}</span>
            <span className="text-xs text-[#8790a6]">{roleLabel}</span>
          </div>
          <form action="/api/auth/logout" method="post">
            <button className="min-h-10 px-2 text-xs font-semibold text-[#c5cbd9] hover:text-white">Keluar</button>
          </form>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-5 sm:px-8 md:pb-12 md:pt-6">{children}</main>
    </div>
  )
}
