'use client'

import { useState } from 'react'

/** Bukti receipt dimuat hanya saat dibuka (route privat); membukanya tercatat sebagai pemeriksaan owner. */
export function ReceiptViewer({ claimId, viewed }: { claimId: string; viewed: boolean }) {
  const [open, setOpen] = useState(false)
  const src = `/api/benefit-receipt/${claimId}`
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex min-h-8 items-center text-sm font-semibold text-orange-700">
        {open ? 'Tutup bukti' : 'Lihat bukti'}
      </button>
      {!open && <span className="text-xs text-ink-500">{viewed ? 'Sudah diperiksa' : 'Belum dibuka'}</span>}
      {open && (
        <a href={src} target="_blank" rel="noopener" title="Buka ukuran penuh">
          {/* eslint-disable-next-line @next/next/no-img-element -- gambar privat dari route sendiri, tanpa optimasi publik */}
          <img src={src} alt="Bukti receipt" className="max-h-56 w-44 rounded-lg border border-cream-300 object-contain" />
        </a>
      )}
    </div>
  )
}
