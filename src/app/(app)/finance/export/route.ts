import { NextResponse, type NextRequest } from 'next/server'
import { createSessionClient } from '@/lib/supabase/server'
import { periodRange, type Period } from '@/lib/finance'
import { addDays, isYmd, jktDate, jktDateTime } from '@/lib/format'

// Khusus owner: dicek lewat current_app_role, dan RLS orders tetap membatasi baris yang terbaca.
export async function GET(req: NextRequest) {
  const supabase = await createSessionClient()
  const { data: role } = await supabase.rpc('current_app_role')
  if (role !== 'owner') return new NextResponse('Forbidden', { status: 403 })
  const sp = req.nextUrl.searchParams
  const p = (['day', 'week', 'month'].includes(sp.get('p') ?? '') ? sp.get('p') : 'week') as Period
  const d = isYmd(sp.get('d')) ? sp.get('d')! : jktDate()
  const [s, e] = periodRange(p, d)
  const [{ data: orders }, { data: profiles }] = await Promise.all([
    supabase.from('orders')
      .select('code, confirmed_at, admin_id, customer_name, menu_price, discount, manual_discount, price_after_discount, sell_price, allocated_cost, hpp, gross_profit, extra_cost, net_profit, needs_review, review_reasons, vouchers(code)')
      .eq('status', 'confirmed').gte('confirmed_at', `${s}T00:00:00+07:00`).lt('confirmed_at', `${addDays(e, 1)}T00:00:00+07:00`)
      .order('confirmed_at'),
    supabase.from('profiles').select('id, full_name'),
  ])
  const esc = (v: unknown) => {
    const x = String(v ?? '')
    const safe = /^[=+\-@]/.test(x) ? `'${x}` : x
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['ID order', 'Waktu', 'Admin', 'Customer', 'Voucher', 'Harga menu', 'Potongan', 'Potongan manual', 'Bayar merchant', 'Harga jual', 'Modal voucher', 'HPP', 'Laba kotor', 'Biaya tambahan', 'Laba bersih', 'Perlu tinjau']
  const lines = (orders ?? []).map((o) => {
    const v = (Array.isArray(o.vouchers) ? o.vouchers[0] : o.vouchers) as { code: string } | null
    return [o.code, jktDateTime(o.confirmed_at), profiles?.find((x) => x.id === o.admin_id)?.full_name, o.customer_name, v?.code, o.menu_price, o.discount,
      o.manual_discount ? 'ya' : '', o.price_after_discount, o.sell_price, o.allocated_cost, o.hpp, o.gross_profit, o.extra_cost, o.net_profit,
      o.needs_review ? (o.review_reasons as string[]).join('; ') : '']
  })
  const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(',')).join('\r\n')
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="order-${s}_${e}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
