import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/auth'
import { MobileNav, SideNav, type NavItem } from './nav'
import { PageTransition } from '@/components/motion'

const STAFF_NAV: NavItem[] = [
  { href: '/', label: 'Beranda', icon: 'home' },
  { href: '/orders/new', label: 'Transaksi Order', icon: 'cart' },
  { href: '/accounts', label: 'Daftar Akun', icon: 'user' },
  { href: '/vouchers/history', label: 'Riwayat Voucher', icon: 'history' },
  { href: '/stock', label: 'Stok & Restock', icon: 'box' },
  { href: '/panel', label: 'Panel Admin', icon: 'restock' },
  { href: '/attendance', label: 'Absensi & Benefit', icon: 'calendar' },
]
const OWNER_NAV: NavItem[] = [
  { href: '/finance', label: 'Keuangan', icon: 'chart' },
  { href: '/vm', label: 'Virtual Machine', icon: 'monitor' },
  { href: '/settings/vouchers', label: 'Konfigurasi Voucher', icon: 'settings' },
  { href: '/owner/attendance', label: 'Absensi & Staf', icon: 'clock' },
  { href: '/approvals', label: 'Persetujuan', icon: 'shield' },
]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer() // sama dengan yang dipakai halaman: satu pemeriksaan per request
  if (!viewer) redirect('/login')
  const { supabase, profile, isOwner } = viewer
  if (profile.must_change_password) redirect('/account/password')
  const roleLabel = isOwner ? 'Owner' : 'Staf'
  // Owner tidak absen: kehadiran staf dikelola lewat Absensi & Staf. Halaman /attendance mengarahkan owner ke sana.
  const staffNav = isOwner ? STAFF_NAV.filter((n) => n.href !== '/attendance') : STAFF_NAV
  let ownerNav: NavItem[] | null = null
  if (isOwner) {
    const { count } = await supabase.from('approval_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    ownerNav = OWNER_NAV.map((n) => (n.href === '/approvals' ? { ...n, badge: count ?? 0 } : n))
  }
  const logo = (
    <span className="flex flex-col">
      <span className="font-display text-xl font-extrabold leading-tight text-navy-900">
        PROMO<span className="text-orange-500">HOLIC</span>
      </span>
      <span className="text-[11px] font-medium tracking-[0.04em] text-ink-500">Control Center</span>
    </span>
  )
  // Bilah bawah HP: modul harian. Sisanya ada di laci Menu.
  const primary = isOwner ? ['/', '/orders/new', '/accounts', '/finance'] : ['/', '/orders/new', '/accounts', '/attendance']

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* HP: header ringkas + bilah navigasi bawah + laci Menu. */}
      <MobileNav logo={logo} staff={staffNav} owner={ownerNav} name={profile.full_name} role={roleLabel} primary={primary} />

      {/* Tablet & desktop: sidebar menempel setinggi layar; di tablet bisa diciutkan menjadi rel ikon. */}
      <SideNav logo={logo} staff={staffNav} owner={ownerNav} name={profile.full_name} role={roleLabel} />

      <main className="min-w-0 flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 md:pb-12 md:pt-7 lg:px-8">
        <PageTransition>{children}</PageTransition>
      </main>
    </div>
  )
}
