import { NextResponse, type NextRequest } from 'next/server'
import { createSessionClient } from '@/lib/supabase/server'
import { loadTypeSummary } from '@/lib/stock'
import { jktDate } from '@/lib/format'

export async function GET(req: NextRequest) {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return new NextResponse('Unauthorized', { status: 401 })
  const brand = req.nextUrl.searchParams.get('brand') ?? undefined
  const rows = await loadTypeSummary(supabase, brand && /^[A-Z]{2}$/.test(brand) ? brand : undefined)
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['Brand', 'Kode', 'Jenis voucher', 'Kelompok', 'Total masuk', 'Terpakai', 'Dipesan', 'Kedaluwarsa', 'Rusak', 'Sisa', 'Ketentuan']
  const lines = rows.map((r) => [r.brand_id, r.code, r.name, r.grp === 'main' ? 'Utama' : 'Tambahan', r.total, r.used, r.reserved, r.expired, r.broken, r.available, r.configured ? r.rule : 'Belum dikonfigurasi'])
  const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(',')).join('\r\n')
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="stok-promoholic-${jktDate()}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
