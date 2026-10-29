// Format tampilan. Semua tanggal & jam ditampilkan dalam zona Asia/Jakarta.
export const TZ = 'Asia/Jakarta'

export function rupiah(n: number | string | null | undefined) {
  if (n === null || n === undefined || n === '') return '—'
  const v = Math.round(Number(n))
  return (v < 0 ? '−Rp' : 'Rp') + Math.abs(v).toLocaleString('id-ID')
}

/** Tanggal kalender Jakarta (YYYY-MM-DD) dari sebuah waktu. */
export function jktDate(d: Date | string = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d))
}

export function jktTime(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

export function jktDateTime(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

/** Label tanggal untuk string YYYY-MM-DD (tanpa pergeseran zona waktu). */
export function dateLabel(ymd: string, style: 'short' | 'long' = 'short') {
  const d = new Date(ymd + 'T12:00:00+07:00')
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: TZ,
    weekday: style === 'long' ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
    ...(style === 'long' ? { year: 'numeric' } : {}),
  }).format(d)
}

export function addDays(ymd: string, n: number) {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Senin dari minggu yang memuat tanggal ini. */
export function weekStart(ymd: string = jktDate()) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay() || 7
  return addDays(ymd, 1 - dow)
}

export function isYmd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

export function minutesLabel(m: number | null | undefined) {
  if (m === null || m === undefined) return '—'
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} j ${r} m` : `${h} j`
}

/** Nilai input datetime-local (jam Jakarta) → ISO dengan zona +07:00. */
export function jktLocalToIso(v: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+07:00` : null
}

/** ISO → nilai input datetime-local dalam jam Jakarta. */
export function isoToJktLocal(iso: string) {
  return `${jktDate(iso)}T${jktTime(iso).replace('.', ':')}`
}

export const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min']
