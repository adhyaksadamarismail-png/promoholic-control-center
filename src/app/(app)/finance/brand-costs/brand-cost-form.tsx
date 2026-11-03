'use client'

import { useState } from 'react'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputCls, labelCls } from '@/components/ui'
import { BASIS_LABEL, type CostBasis } from '@/lib/brand-costs'
import { setBrandCost } from '../actions'

const HELP: Record<CostBasis, string> = {
  credit_per_account: 'Modal satu akun = jumlah kredit × harga kredit yang berlaku, lalu dibagi ke voucher utama akun itu.',
  rp_per_voucher: 'Setiap voucher yang masuk dicatat dengan biaya ini.',
  free: 'Akun brand ini tidak memerlukan biaya. Pilih hanya bila memang sudah dipastikan gratis.',
}

/** Form versi modal baru untuk satu brand. Tidak ada nilai bawaan: semua angka diisi owner. */
export function BrandCostForm({ brand, brandName, today, creditPrice }: { brand: string; brandName: string; today: string; creditPrice: number | null }) {
  const [basis, setBasis] = useState<CostBasis | ''>('')
  const [credits, setCredits] = useState('')
  const n = Number(credits.replace(',', '.'))

  return (
    <ActionForm action={setBrandCost} className="flex flex-col gap-3">
      <input type="hidden" name="brand" value={brand} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold">Metode biaya</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(Object.keys(BASIS_LABEL) as CostBasis[]).map((k) => (
            <label key={k} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${basis === k ? 'border-navy-900 bg-navy-100' : 'border-[#dcd2bf] bg-white'}`}>
              <input type="radio" name="basis" value={k} checked={basis === k} onChange={() => setBasis(k)} required />
              {BASIS_LABEL[k]}
            </label>
          ))}
        </div>
        {basis && <p className="text-xs text-ink-500">{HELP[basis]}</p>}
      </fieldset>

      {basis === 'credit_per_account' && (
        <label className={labelCls}>
          Jumlah kredit per akun
          <input name="credits" inputMode="decimal" required value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="Isi jumlah kredit" className={inputCls} />
          <span className="text-xs font-normal text-ink-500">
            {!creditPrice
              ? 'Harga kredit belum dikonfigurasi: atur dulu di Keuangan → Harga modal, atau akun baru tetap ditolak.'
              : Number.isFinite(n) && n > 0
                ? `= Rp${Math.round(n * creditPrice).toLocaleString('id-ID')} per akun dengan harga kredit saat ini`
                : `Harga kredit saat ini Rp${creditPrice.toLocaleString('id-ID')}.`}
          </span>
        </label>
      )}
      {basis === 'rp_per_voucher' && (
        <label className={labelCls}>
          Biaya per voucher (Rp)
          <input name="rp" inputMode="numeric" required placeholder="Isi nominal Rupiah" className={inputCls} />
        </label>
      )}
      {basis === 'free' && (
        <label className="flex items-start gap-2 rounded-lg bg-warning-100 px-3 py-2.5 text-sm text-warning-700">
          <input type="checkbox" name="confirm_free" required className="mt-0.5" />
          Saya konfirmasi akun {brandName} memang gratis (modal Rp0).
        </label>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          Mulai berlaku
          <input type="date" name="from" min={today} defaultValue={today} required className={inputCls} />
          <span className="text-xs font-normal text-ink-500">Pukul 00:00 WIB. Hari ini = langsung dipakai untuk restock berikutnya.</span>
        </label>
        <label className={labelCls}>
          Catatan (opsional)
          <input name="note" maxLength={200} placeholder="mis. harga dari supplier per Nov" className={inputCls} />
          <span className="text-xs font-normal text-ink-500">Disimpan di audit log.</span>
        </label>
      </div>
      <div><SubmitButton variant="accent">Simpan modal {brandName}</SubmitButton></div>
    </ActionForm>
  )
}
