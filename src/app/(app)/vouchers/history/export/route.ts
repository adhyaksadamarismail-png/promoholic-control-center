import { NextResponse, type NextRequest } from 'next/server'
import { createSessionClient } from '@/lib/supabase/server'
import { loadHistory } from '@/lib/history'
import { addDays, isYmd, jktDate, jktDateTime } from '@/lib/format'
import { LEDGER_REASON } from '@/lib/inventory'

// Memakai sesi & view tersamar yang sama dengan layar.
export async function GET(req: NextRequest) {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return new NextResponse('Unauthorized', { status: 401 })
  const p = req.nextUrl.searchParams
  const to = isYmd(p.get('to')) ? p.get('to')! : jktDate()
  const from = isYmd(p.get('from')) ? p.get('from')! : addDays(to, -6)
  const rows = await loadHistory(supabase, { from, to, brand: p.get('brand') ?? undefined, event: p.get('event') ?? undefined, q: p.get('q') ?? undefined })
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['Waktu', 'Peristiwa', 'Voucher', 'Akun', 'Jenis', 'Customer', 'WhatsApp', 'Order / referensi', 'Pelaku', 'Status voucher', 'Catatan']
  const lines = rows.map((r) => [jktDateTime(r.at), LEDGER_REASON[r.reason] ?? r.reason, r.voucherCode, r.accountCode, r.typeName, r.customer, r.wa, r.orderCode ?? r.ref, r.actor, r.status, r.note])
  const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(',')).join('\r\n')
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="riwayat-voucher-${from}_${to}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
