import { NextResponse, type NextRequest } from 'next/server'
import { createSessionClient } from '@/lib/supabase/server'
import { loadAccounts } from '@/lib/accounts'
import { ACCOUNT_STATE, VOUCHER_STATUS } from '@/lib/inventory'
import { jktDate } from '@/lib/format'

// Export memakai sesi pengguna dan view yang sama, jadi staf mendapat nomor tersamar seperti di layar.
export async function GET(req: NextRequest) {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return new NextResponse('Unauthorized', { status: 401 })
  const p = req.nextUrl.searchParams
  const { brands, types, filtered } = await loadAccounts(supabase, {
    q: p.get('q') ?? undefined, brand: p.get('brand') ?? undefined, source: p.get('source') ?? undefined, status: p.get('status') ?? undefined,
  })
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    // Cegah formula injection saat dibuka di spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['ID akun', 'Brand', 'Sumber', 'Device', 'Nomor akun', 'Masuk', 'Aktif s/d', 'Status', 'Voucher tersedia', 'Rincian voucher']
  const lines = filtered.map((r) => [
    r.account_code,
    brands.find((b) => b.id === r.brand_id)?.name,
    r.source === 'vm' ? 'Virtual Machine' : 'Panel Admin',
    r.vm_device_id,
    r.account_number,
    jktDate(r.entered_at),
    r.active_until,
    ACCOUNT_STATE[r.state].label,
    r.vouchers.filter((v) => v.status === 'available').length,
    r.vouchers.map((v) => `${types.find((t) => t.id === v.voucher_type_id)?.code}:${VOUCHER_STATUS[v.status].label}`).join(' | '),
  ])
  const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(',')).join('\r\n')
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="akun-promoholic-${jktDate()}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
