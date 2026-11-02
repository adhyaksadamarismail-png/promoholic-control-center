// Input Bulk Transaksi: tempel dari spreadsheet atau CSV template. Validasi sebenarnya ada di server.

export type BulkOrderInput = {
  key: string // identitas baris + kunci idempotensi record_order; tetap sama saat disimpan ulang
  brand: string
  account: string
  voucher: string
  name: string
  wa: string
  menu: number | null
  sell: number | null
  extra: number | null
  manual: number | null
  override: number | null
  ref: string
}

export const BULK_ORDER_COLUMNS = ['brand', 'id_akun', 'voucher', 'nama_customer', 'whatsapp', 'harga_menu', 'harga_jual', 'biaya_tambahan', 'potongan_manual', 'harga_merchant', 'referensi'] as const
export const BULK_ORDER_TEMPLATE = `${BULK_ORDER_COLUMNS.join(',')}\nKK,195678,A,Nama Customer,081234567890,74000,50000,0,,,\n`

const money = (v: string | undefined) => {
  const d = (v ?? '').replace(/[^\d]/g, '')
  return d ? Number(d) : null
}

/** Satu baris teks → kolom. Tab (tempel dari spreadsheet) atau koma/titik koma, dengan tanda kutip CSV. */
function splitRow(line: string) {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim())
  const sep = !line.includes(',') && line.includes(';') ? ';' : ','
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
    } else if (ch === sep && !quoted) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  out.push(cur.trim())
  return out
}

/** Baris header boleh ada; urutan kolom mengikuti header bila ada, selain itu urutan template. */
export function parseBulkOrders(text: string, newKey: () => string): BulkOrderInput[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const first = splitRow(lines[0]).map((c) => c.toLowerCase())
  const hasHeader = first.includes('id_akun') || first.includes('brand')
  const cols: string[] = hasHeader ? first : [...BULK_ORDER_COLUMNS]
  return lines.slice(hasHeader ? 1 : 0).map((line) => {
    const cells = splitRow(line)
    const at = (c: string) => { const i = cols.indexOf(c); return i < 0 ? undefined : cells[i] }
    return {
      key: newKey(),
      brand: at('brand') ?? '', account: at('id_akun') ?? '', voucher: at('voucher') ?? '',
      name: at('nama_customer') ?? '', wa: at('whatsapp') ?? '',
      menu: money(at('harga_menu')), sell: money(at('harga_jual')), extra: money(at('biaya_tambahan')),
      manual: money(at('potongan_manual')), override: money(at('harga_merchant')), ref: at('referensi') ?? '',
    }
  })
}
