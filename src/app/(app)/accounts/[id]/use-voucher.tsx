'use client'

import { useState } from 'react'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputCls, labelCls } from '@/components/ui'
import { previewDiscount, type Rule } from '@/lib/inventory'
import { markVoucherUsed } from './actions'

const rp = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID')
const num = (v: string) => (v.replace(/\D/g, '') ? Number(v.replace(/\D/g, '')) : null)

/**
 * "Tandai dipakai" = mencatat order singkat untuk voucher ini (record_order), sehingga omzet, HPP, laba,
 * dan pencegahan pemakaian ganda tetap berlaku. Potongan dihitung dari ketentuan; tanpa ketentuan lengkap
 * potongan diisi manual dan order ditandai untuk ditinjau. Server menghitung ulang semuanya.
 */
export function UseVoucherForm({ voucherId, voucherCode, accountId, rule }: { voucherId: string; voucherCode: string; accountId: string; rule: Rule | null }) {
  const [open, setOpen] = useState(false)
  const [idem] = useState(() => crypto.randomUUID())
  const [menu, setMenu] = useState('')
  const [manual, setManual] = useState('')
  const pv = previewDiscount(num(menu) ?? 0, rule, num(manual))

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 w-full rounded-lg border border-navy-900 bg-white px-3 text-sm font-semibold text-navy-900">
        Tandai dipakai
      </button>
    )

  return (
    <ActionForm
      action={markVoucherUsed}
      className="flex flex-col gap-2 rounded-xl bg-cream-100 p-3"
      confirm={`Tandai ${voucherCode} sebagai dipakai? Order dicatat dan voucher tidak bisa dipakai lagi kecuali dibatalkan resmi.`}
    >
      <input type="hidden" name="voucher" value={voucherId} />
      <input type="hidden" name="account" value={accountId} />
      <input type="hidden" name="idem" value={idem} />
      <label className={labelCls}>Nama customer<input name="customer_name" required autoComplete="off" className={inputCls} /></label>
      <label className={labelCls}>WhatsApp customer<input name="customer_wa" required inputMode="tel" placeholder="08xx-xxxx-xxxx" autoComplete="off" className={inputCls} /></label>
      <label className={labelCls}>
        Harga asli menu (Rp)
        <input name="menu_price" required inputMode="numeric" value={menu} onChange={(e) => setMenu(e.target.value)} className={inputCls} />
      </label>
      {pv.manualNeeded && (
        <label className={labelCls}>
          Potongan manual (Rp)
          <input name="manual_discount" required inputMode="numeric" value={manual} onChange={(e) => setManual(e.target.value)} className={inputCls} />
          <span className="text-xs font-normal text-warning-700">Ketentuan voucher belum lengkap: order ditandai untuk ditinjau owner.</span>
        </label>
      )}
      <label className={labelCls}>Harga jual Promo.Holic (Rp)<input name="sell_price" required inputMode="numeric" className={inputCls} /></label>
      <p className="text-xs text-ink-500">
        {pv.error ?? (pv.discount !== null ? `Potongan ${rp(pv.discount)} · bayar merchant ${rp((num(menu) ?? 0) - pv.discount)}` : 'Isi harga menu untuk melihat potongan.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="accent" pendingText="Menyimpan…">Simpan pemakaian</SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Batal</button>
      </div>
    </ActionForm>
  )
}
