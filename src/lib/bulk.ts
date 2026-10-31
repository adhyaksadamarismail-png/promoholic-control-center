// Parser input Bulk Restock (teks tempel atau CSV). Dipakai di browser untuk preview; validasi sebenarnya
// (akun terdaftar, duplikat, device, nomor, aturan brand) selalu diulang di database.

export type BulkSource = 'panel' | 'vm'
export type BulkMode = 'new_account' | 'add_stock' | 'extra_only' | 'baperan'
export type BulkRow = { line: number; device: string | null; code: string | null; number: string | null; items: Record<string, number>; parseError?: string }

const ITEM_ALIAS: Record<string, string> = { BAPERAN: 'BP' }
const HEADER = {
  device: ['device', 'vm', 'vd', 'id_device', 'virtual_device'],
  code: ['akun', 'id_akun', 'account', 'account_id', 'id'],
  number: ['nomor', 'nomor_akun', 'number', 'no', 'no_hp'],
}

const itemKey = (k: string) => {
  const u = k.trim().toUpperCase()
  return ITEM_ALIAS[u] ?? u
}
const isDevice = (t: string) => /^(VM|VD)-?\d{1,4}$/i.test(t)
const isPhone = (t: string) => /^(\+?62|0)8[\d\s-]{8,15}$/.test(t) && t.replace(/\D/g, '').length >= 10
const splitLine = (l: string) => (l.includes('|') ? l.split('|') : l.includes('\t') ? l.split('\t') : l.includes(';') ? l.split(';') : l.split(',')).map((t) => t.trim())

export function parseBulk(text: string, source: BulkSource): BulkRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const rows: BulkRow[] = []
  let header: string[] | null = null

  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const tokens = splitLine(line)
    // CSV berheader: baris pertama berisi nama kolom (mis. akun,A,B,C,BAPERAN).
    if (!header && !rows.length && tokens.some((t) => HEADER.code.includes(t.toLowerCase())) && !tokens.some((t) => t.includes('='))) {
      header = tokens.map((t) => t.toLowerCase())
      return
    }
    const row: BulkRow = { line: i + 1, device: null, code: null, number: null, items: {} }
    const setQty = (k: string, v: string) => {
      const n = Number(v.trim())
      if (!v.trim()) return
      if (!Number.isInteger(n) || n < 0) row.parseError = `Jumlah ${itemKey(k)} bukan angka bulat`
      else if (itemKey(k) === 'BP') row.parseError = 'Baperan direstock lewat tab "Restock Baperan saja" (satu nomor = satu akun)'
      else row.items[itemKey(k)] = n
    }

    if (header) {
      header.forEach((h, idx) => {
        const v = tokens[idx] ?? ''
        if (HEADER.device.includes(h)) row.device = v || null
        else if (HEADER.code.includes(h)) row.code = v && v !== '-' ? v : null
        else if (HEADER.number.includes(h)) row.number = v || null
        else if (h) setQty(h, v)
      })
    } else {
      for (const t of tokens) {
        if (!t) continue
        if (t.includes('=')) {
          const [k, v] = t.split('=')
          setQty(k, v ?? '')
        } else if (source === 'vm' && !row.device && !row.code && isDevice(t)) row.device = t.toUpperCase()
        else if (source === 'vm' && row.code && !row.number && isPhone(t)) row.number = t
        else if (!row.code && t !== '-') row.code = t
        else if (t === '-' && !row.code) continue
        else row.parseError = `Kolom tidak dikenali: "${t}"`
      }
    }
    rows.push(row)
  })
  return rows
}

export const BULK_EXAMPLE: Record<BulkSource, Record<BulkMode, string>> = {
  panel: {
    new_account: '123456\n234567\n345678',
    add_stock: 'FR-0008 | D25=2\nSB-0011 | SB=1',
    extra_only: '- | KODE=10',
    baperan: '081234567890 | 123456\n081234567891 |\n081234567892 | 654321',
  },
  vm: {
    new_account: 'VM-01 | 123456 | 0857-1234-5678\nVM-02 | 234567 | 0857-1234-5679',
    add_stock: '195678 | KODE=2',
    extra_only: '195678 | KODE=2',
    baperan: '',
  },
}

/**
 * Bulk Baperan, dua metode identitas: nomor telepon | PIN (PIN boleh kosong), atau ID akun website sumber (satu per baris).
 * Validasi sebenarnya di database; kesalahan satu baris hanya menolak baris itu.
 */
export type BaperanIdentity = 'phone' | 'account_id'
export type BaperanRow = { line: number; number: string | null; account_id: string | null; pin: string | null; parseError?: string }
export const BAPERAN_EXAMPLE: Record<BaperanIdentity, string> = {
  phone: '081234567890 | 123456\n081234567891 |\n081234567892 | 654321',
  account_id: '197865\n197866\n197867',
}

const validPhone = (t: string) => /^(62|0)?8\d{8,11}$/.test(t.replace(/\D/g, ''))

/** Nomor dan PIN yang dipisah spasi: token terakhir adalah PIN hanya bila sisanya sudah nomor telepon utuh. */
function splitPhonePin(line: string): string[] {
  if (/[|,;\t]/.test(line)) return splitLine(line)
  const tokens = line.split(/\s+/)
  const head = tokens.slice(0, -1).join('')
  return tokens.length > 1 && validPhone(head) ? [head, tokens[tokens.length - 1]] : [line]
}

export function parseBaperan(text: string, identity: BaperanIdentity = 'phone'): BaperanRow[] {
  const rows: BaperanRow[] = []
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [first = '', second = '', ...rest] = identity === 'phone' ? splitPhonePin(line) : line.split(/[|,;\s]+/)
    // Baris judul CSV (mis. "nomor,pin" atau "id_akun") dilewati.
    if (!rows.length && /^[a-z_ ]+$/i.test(first) && !/\d/.test(first)) return
    if (identity === 'account_id') {
      const row: BaperanRow = { line: i + 1, number: null, account_id: first, pin: null }
      if (second || rest.some((t) => t)) row.parseError = 'ID Akun tidak memakai PIN: cukup satu ID per baris'
      rows.push(row)
      return
    }
    const row: BaperanRow = { line: i + 1, number: first, account_id: null, pin: second || null }
    if (rest.some((t) => t)) row.parseError = 'Kolom berlebih: format nomor | PIN'
    rows.push(row)
  })
  return rows
}
