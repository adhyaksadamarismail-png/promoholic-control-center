import { rupiah } from '@/lib/format'

export type CostBasis = 'credit_per_account' | 'rp_per_voucher' | 'free'
export type BrandCost = {
  id: number
  brand_id: string
  basis: CostBasis
  credits_per_account: number | string | null
  rp_per_voucher: number | null
  effective_from: string
}

export const BASIS_LABEL: Record<CostBasis, string> = {
  credit_per_account: 'Kredit per akun',
  rp_per_voucher: 'Rupiah per voucher',
  free: 'Gratis',
}

/** Isi versi modal dalam kata-kata, mis. "1 kredit per akun = Rp4.000" (harga kredit saat ini bila ada). */
export function costValue(c: BrandCost, creditPrice: number | null) {
  if (c.basis === 'credit_per_account') {
    const n = Number(c.credits_per_account)
    return `${n.toLocaleString('id-ID')} kredit per akun${creditPrice ? ` = ${rupiah(n * creditPrice)}` : ''}`
  }
  if (c.basis === 'rp_per_voucher') return `${rupiah(c.rp_per_voucher)} per voucher`
  return 'Rp0 (gratis)'
}

/**
 * Status modal satu brand pada waktu `nowIso`: versi aktif (terbaru yang sudah berlaku),
 * versi terjadwal (belum berlaku), dan versi lama (tidak berlaku lagi). Urutan input bebas.
 */
export function brandCostStatus(rows: BrandCost[], brandId: string, nowIso: string) {
  const mine = rows.filter((r) => r.brand_id === brandId).sort((a, b) => b.effective_from.localeCompare(a.effective_from))
  const started = mine.filter((r) => new Date(r.effective_from) <= new Date(nowIso))
  return {
    active: started[0] ?? null,
    scheduled: mine.filter((r) => new Date(r.effective_from) > new Date(nowIso)).reverse(),
    past: started.slice(1),
  }
}
