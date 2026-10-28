export type VoucherStatus = 'available' | 'reserved' | 'used' | 'expired' | 'broken'

export const VOUCHER_STATUS: Record<VoucherStatus, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' | 'info' }> = {
  available: { label: 'Tersedia', tone: 'success' },
  reserved: { label: 'Dipesan (draft)', tone: 'warning' },
  used: { label: 'Terpakai', tone: 'neutral' },
  expired: { label: 'Kedaluwarsa', tone: 'danger' },
  broken: { label: 'Rusak', tone: 'danger' },
}

export const ORDER_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> = {
  confirmed: { label: 'Dikonfirmasi', tone: 'success' },
  draft: { label: 'Draft', tone: 'warning' },
  cancelled: { label: 'Dibatalkan', tone: 'neutral' },
}

export const LEDGER_REASON: Record<string, string> = {
  restock: 'Restock',
  reserve: 'Dipesan (draft)',
  release: 'Draft dibatalkan',
  use: 'Dipakai',
  reversal: 'Order dibatalkan, voucher kembali',
  expire: 'Kedaluwarsa',
  adjust: 'Koreksi stok',
}

export type Rule = {
  discount_pct: number | string | null
  fixed_discount: number | null
  min_purchase: number | null
  max_discount: number | null
  b1g1_terms?: string | null
}

const rp = (n: number) => 'Rp' + n.toLocaleString('id-ID')

export function ruleLabel(r: Rule | null | undefined) {
  if (!r) return 'Ketentuan belum dikonfigurasi'
  const parts: string[] = []
  if (r.fixed_discount !== null) parts.push(`Potongan ${rp(r.fixed_discount)}`)
  else if (r.discount_pct !== null) parts.push(`Diskon ${Number(r.discount_pct)}%`)
  else parts.push(r.b1g1_terms ? `B1G1: ${r.b1g1_terms}` : 'Potongan belum dikonfigurasi')
  parts.push(r.min_purchase ? `min. ${rp(r.min_purchase)}` : 'tanpa minimum')
  if (r.discount_pct !== null && r.fixed_discount === null) parts.push(r.max_discount !== null ? `maks. ${rp(r.max_discount)}` : 'maks. belum dikonfigurasi')
  return parts.join(' · ')
}

/**
 * Pratinjau potongan — sama dengan record_order di database. Server tetap menghitung ulang
 * dan nilai server yang disimpan.
 */
export function previewDiscount(menuPrice: number, r: Rule | null | undefined, manual: number | null) {
  const reasons: string[] = []
  if (!menuPrice || menuPrice <= 0) return { discount: null, reasons, error: null as string | null, manualNeeded: false }
  if (r?.min_purchase && menuPrice < r.min_purchase) {
    return { discount: null, reasons, error: `Di bawah minimum pembelian ${rp(r.min_purchase)}`, manualNeeded: false }
  }
  if (r && r.fixed_discount !== null) return { discount: Math.min(r.fixed_discount, menuPrice), reasons, error: null, manualNeeded: false }
  if (r && r.discount_pct !== null) {
    let d = Math.round((menuPrice * Number(r.discount_pct)) / 100)
    if (r.max_discount !== null) d = Math.min(d, r.max_discount)
    else reasons.push('Batas potongan belum dikonfigurasi')
    return { discount: d, reasons, error: null, manualNeeded: false }
  }
  reasons.push('Potongan manual (ketentuan belum dikonfigurasi)')
  if (manual === null) return { discount: null, reasons, error: null, manualNeeded: true }
  if (manual < 0 || manual > menuPrice) return { discount: null, reasons, error: 'Potongan manual tidak valid', manualNeeded: true }
  return { discount: manual, reasons, error: null, manualNeeded: true }
}

/** Ambil versi aturan yang berlaku (effective_from terbaru yang sudah lewat). */
export function currentVersion<T extends { voucher_type_id: string; effective_from: string }>(versions: T[], typeId: string, at = Date.now()) {
  return versions
    .filter((v) => v.voucher_type_id === typeId && Date.parse(v.effective_from) <= at)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
}

export type AccountState = 'complete' | 'partial' | 'empty' | 'review'
export const ACCOUNT_STATE: Record<AccountState, { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = {
  complete: { label: 'Lengkap', tone: 'success' },
  partial: { label: 'Beberapa terpakai', tone: 'info' },
  empty: { label: 'Habis', tone: 'neutral' },
  review: { label: 'Perlu diperiksa', tone: 'warning' },
}

export function accountState(needsReview: boolean, statuses: VoucherStatus[]): AccountState {
  if (needsReview || statuses.some((s) => s === 'broken')) return 'review'
  const avail = statuses.filter((s) => s === 'available').length
  if (!avail) return 'empty'
  return avail === statuses.length ? 'complete' : 'partial'
}

/** Rapikan ID akun: huruf besar, tanpa spasi. Tetap teks agar leading zero aman. */
export function normalizeAccountCode(v: string) {
  return v.replace(/\s/g, '').toUpperCase()
}

/** Sama dengan validasi di database (_check_account_code). */
export function accountCodeError(code: string): string | null {
  if (code.length < 3 || code.length > 32) return 'ID akun 3–32 karakter, mis. 195678 atau KK-195678.'
  if (!/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(code)) return 'ID akun hanya boleh huruf dan angka; tanda hubung hanya di tengah (mis. KK-195678).'
  return null
}

/** Identitas akun tanpa prefix brand: "KK-195678" dan "195678" adalah akun yang sama di brand KK. */
export function accountKey(brand: string, code: string) {
  return code.startsWith(brand + '-') ? code.slice(brand.length + 1) : code
}

/** Basis ID voucher, sama dengan _voucher_base di database. */
export function voucherBase(brand: string, code: string) {
  return brand + accountKey(brand, code).replace(/[^A-Z0-9]/g, '')
}
