'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { inputCls } from '@/components/ui'

/** Pencarian langsung: hasil diperbarui saat mengetik (jeda singkat) dan tetap mengikuti filter yang aktif. */
export function AccountSearch({ placeholder = 'Ketik ID akun, nomor, atau ID voucher' }: { placeholder?: string }) {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const [value, setValue] = useState(params.get('q') ?? '')
  const [pending, start] = useTransition()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function change(v: string) {
    setValue(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (v.trim()) next.set('q', v.trim()); else next.delete('q')
      next.delete('archived')
      start(() => router.replace(`${path}${next.size ? `?${next}` : ''}`, { scroll: false }))
    }, 250)
  }

  return (
    <span className="relative block">
      <input name="q" type="search" value={value} onChange={(e) => change(e.target.value)} placeholder={placeholder} autoComplete="off" inputMode="search" className={`${inputCls} w-full pr-10 text-base`} />
      {pending && <span aria-label="Mencari" role="status" className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-cream-300 border-t-orange-500" />}
    </span>
  )
}
