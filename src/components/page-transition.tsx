'use client'

import { usePathname, useSearchParams } from 'next/navigation'

/**
 * Konten halaman muncul halus saat berpindah halaman atau tab (?mode=, ?tab=, ?view=). Pembaruan data di halaman
 * yang sama (simpan form, muat ulang otomatis) tidak memicu animasi karena alamatnya tidak berubah.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const qs = useSearchParams().toString()
  return (
    <div key={`${path}?${qs}`} className="animate-enter">
      {children}
    </div>
  )
}
