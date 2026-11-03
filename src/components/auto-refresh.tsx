'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Muat ulang data halaman (server) berkala dan saat tab kembali aktif, agar status absensi yang diubah
 * owner/admin terlihat tanpa reload manual. Dilewati selama pengguna sedang mengetik di form.
 */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement
      return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
    }
    const refresh = () => { if (document.visibilityState === 'visible' && !typing()) router.refresh() }
    const id = window.setInterval(refresh, seconds * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router, seconds])
  return null
}
