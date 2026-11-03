'use client'

import { startTransition, useActionState, useEffect, useRef, useState } from 'react'
import { useHydrated } from '@/components/action-form'
import { submitBenefit } from './actions'

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp']
const MAX = 5 * 1024 * 1024

/** Form pengajuan benefit: pilih ukuran, unggah & pratinjau receipt, periksa ringkasan, lalu ajukan. */
export function BenefitForm({ shiftId, shiftCode, shiftDate, resubmit }: { shiftId: string; shiftCode: string; shiftDate: string; resubmit: boolean }) {
  const hydrated = useHydrated()
  const [state, action, pending] = useActionState(submitBenefit, null)
  const [cup, setCup] = useState<'regular' | 'large' | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  function pick(f: File | undefined) {
    setError('')
    if (!f) return
    if (!ACCEPT.includes(f.type)) return setError('Pilih gambar JPG, PNG, atau WebP.')
    if (f.size > MAX) return setError('Ukuran gambar maksimal 5 MB.')
    if (preview) URL.revokeObjectURL(preview)
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }
  function clear() {
    if (preview) URL.revokeObjectURL(preview)
    setFile(null)
    setPreview(null)
    if (input.current) input.current.value = ''
  }

  const ready = !!cup && !!file
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        const fd = new FormData()
        fd.set('shift', shiftId)
        fd.set('cup_size', cup)
        fd.set('receipt', file)
        startTransition(() => action(fd))
      }}
    >
      <fieldset disabled={pending || !hydrated} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">1. Ukuran cup</span>
          <div className="grid grid-cols-2 gap-2">
            {(['regular', 'large'] as const).map((c) => (
              <label key={c} className={`flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-lg border text-sm font-semibold ${cup === c ? 'border-navy-900 bg-navy-900 text-white' : 'border-[#dcd2bf] bg-white'}`}>
                <input type="radio" name="cup_size" value={c} checked={cup === c} onChange={() => setCup(c)} className="sr-only" />
                {c === 'regular' ? 'Regular' : 'Large'}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">2. Bukti receipt KopKen</span>
          <input ref={input} type="file" accept={ACCEPT.join(',')} className="sr-only" id={`receipt-${shiftId}`} onChange={(e) => pick(e.target.files?.[0])} />
          {preview ? (
            <div className="flex flex-col gap-2 rounded-xl border border-cream-300 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- pratinjau lokal (blob:), tidak dioptimasi */}
              <img src={preview} alt="Pratinjau receipt" className="max-h-64 w-full rounded-lg object-contain" />
              <span className="truncate text-xs text-ink-500">{file?.name} · {Math.ceil((file?.size ?? 0) / 1024)} KB</span>
              <div className="flex gap-2">
                <label htmlFor={`receipt-${shiftId}`} className="flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-lg border border-[#dcd2bf] text-sm font-semibold">Ganti gambar</label>
                <button type="button" onClick={clear} className="min-h-10 flex-1 rounded-lg border border-danger-700 text-sm font-semibold text-danger-700">Hapus</button>
              </div>
            </div>
          ) : (
            <label htmlFor={`receipt-${shiftId}`} className="flex min-h-20 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-[#dcd2bf] bg-cream-50 text-sm">
              <span className="font-semibold text-navy-900">Pilih foto / screenshot receipt</span>
              <span className="text-xs text-ink-500">JPG, PNG, atau WebP · maks. 5 MB</span>
            </label>
          )}
        </div>

        <div className="rounded-xl bg-cream-100 p-3 text-sm">
          <span className="mb-1 block font-semibold">3. Ringkasan</span>
          <div className="flex justify-between"><span className="text-ink-500">Shift</span><span className="font-semibold">{shiftCode} · {shiftDate}</span></div>
          <div className="flex justify-between"><span className="text-ink-500">Ukuran</span><span className="font-semibold">{cup ? (cup === 'regular' ? 'Regular' : 'Large') : 'belum dipilih'}</span></div>
          <div className="flex justify-between"><span className="text-ink-500">Bukti</span><span className="font-semibold">{file ? 'terlampir' : 'belum ada'}</span></div>
        </div>

        {(error || (state && !state.ok)) && <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{error || state?.message}</p>}
        <button type="submit" disabled={!ready} className="min-h-12 rounded-lg bg-orange-500 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
          {pending ? 'Mengunggah…' : resubmit ? 'Ajukan Ulang Pengambilan' : 'Ajukan Pengambilan'}
        </button>
      </fieldset>
    </form>
  )
}
