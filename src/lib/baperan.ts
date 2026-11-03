// Inventaris Baperan: satu nomor telepon = satu akun = tepat 1 voucher Baperan. Status masa aktif dihitung dari
// accounts.active_until (berlaku sampai akhir tanggalnya, WIB). Kedaluwarsa juga ditolak database saat order.
import type { Tone } from '@/components/ui'
import { addDays, jktDate } from '@/lib/format'

/** Akun dianggap "segera kedaluwarsa" bila sisa masa aktifnya 3 hari atau kurang. */
export const BAPERAN_SOON_DAYS = 3

export type BaperanStatus = 'aktif' | 'segera' | 'kedaluwarsa'
export const BAPERAN_STATUS: Record<BaperanStatus, { label: string; tone: Tone }> = {
  aktif: { label: 'Aktif', tone: 'success' },
  segera: { label: 'Segera Kedaluwarsa', tone: 'warning' },
  kedaluwarsa: { label: 'Kedaluwarsa', tone: 'danger' },
}

export function baperanStatus(activeUntil: string | null, today: string = jktDate()): BaperanStatus {
  if (!activeUntil || activeUntil < today) return 'kedaluwarsa'
  return activeUntil <= addDays(today, BAPERAN_SOON_DAYS) ? 'segera' : 'aktif'
}

/** Sisa hari sampai akhir masa aktif (0 = hari terakhir; negatif = sudah lewat). */
export function daysLeft(activeUntil: string, today: string = jktDate()) {
  return Math.round((Date.parse(activeUntil + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000)
}

export function daysLeftLabel(activeUntil: string, today: string = jktDate()) {
  const d = daysLeft(activeUntil, today)
  if (d < 0) return `lewat ${-d} hari`
  if (d === 0) return 'hari terakhir'
  return `${d} hari lagi`
}

/** Tampilan nomor telepon: 0812-3456-7890. Nilai yang disalin tetap tanpa tanda hubung. */
export function phoneLabel(n: string | null | undefined) {
  if (!n) return '—'
  return n.replace(/^(\d{4})(\d{4})(\d+)$/, '$1-$2-$3')
}
