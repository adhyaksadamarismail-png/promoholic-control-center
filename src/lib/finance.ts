import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays, dateLabel, weekStart } from '@/lib/format'

export type Period = 'day' | 'week' | 'month'

/** Rentang tanggal Jakarta [start, end] untuk periode yang memuat tanggal d. */
export function periodRange(p: Period, d: string): [string, string] {
  if (p === 'day') return [d, d]
  if (p === 'week') {
    const s = weekStart(d)
    return [s, addDays(s, 6)]
  }
  const s = d.slice(0, 8) + '01'
  const next = new Date(s + 'T12:00:00Z')
  next.setUTCMonth(next.getUTCMonth() + 1)
  return [s, addDays(next.toISOString().slice(0, 10), -1)]
}

export function shiftPeriod(p: Period, d: string, n: number) {
  if (p === 'day') return addDays(d, n)
  if (p === 'week') return addDays(weekStart(d), 7 * n)
  const x = new Date(d.slice(0, 8) + '01T12:00:00Z')
  x.setUTCMonth(x.getUTCMonth() + n)
  return x.toISOString().slice(0, 10)
}

export function periodLabel(p: Period, d: string) {
  const [s, e] = periodRange(p, d)
  if (p === 'day') return dateLabel(s, 'long')
  if (p === 'week') return `${dateLabel(s)} – ${dateLabel(e)}`
  return new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date(s + 'T12:00:00+07:00'))
}

const BUCKETS: Record<Period, number> = { day: 14, week: 8, month: 6 }

export type Pnl = {
  orders: number
  review: number
  revenue: number
  merchant: number
  voucherCost: number
  gross: number
  extraCost: number
  expiredLoss: number
  payroll: number
  expenses: number
  net: number
}

const startIso = (ymd: string) => `${ymd}T00:00:00+07:00`
const endIso = (ymd: string) => `${addDays(ymd, 1)}T00:00:00+07:00`
const JKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
const jkt = (iso: string) => JKT_DAY.format(new Date(iso))

/**
 * Laba rugi dari transaksi tersimpan. Order memakai nilai snapshot saat dicatat (tidak dihitung ulang
 * walau harga modal atau aturan voucher berubah). Order yang dibatalkan resmi tidak dihitung.
 */
export async function loadFinance(supabase: SupabaseClient, p: Period, d: string) {
  const first = periodRange(p, shiftPeriod(p, d, -(BUCKETS[p] - 1)))[0]
  const [cs, ce] = periodRange(p, d)
  const last = ce
  // Hanya voucher yang memengaruhi angka: kedaluwarsa/rusak di rentang grafik (modal ikut lewat relasi),
  // masuk di periode berjalan, dan stok tersedia/dipesan. Bukan seluruh voucher yang pernah dibuat.
  const [{ data: orders }, { data: expenses }, { data: earnings }, { data: expiredLedger }, { data: vouchersIn }, { data: vouchersOnHand }, { data: purchases }] = await Promise.all([
    supabase.from('orders').select('code, confirmed_at, sell_price, price_after_discount, allocated_cost, gross_profit, extra_cost, needs_review')
      .eq('status', 'confirmed').gte('confirmed_at', startIso(first)).lt('confirmed_at', endIso(last)),
    supabase.from('expenses').select('id, spent_on, category, amount_rp, note').gte('spent_on', first).lte('spent_on', last).order('spent_on', { ascending: false }),
    supabase.from('shift_earnings').select('base_allowance, bonus, shifts!inner(shift_date)').eq('status', 'approved').gte('shifts.shift_date', first).lte('shifts.shift_date', last),
    supabase.from('stock_ledger').select('voucher_id, at, status_after, vouchers(allocated_cost)').in('status_after', ['expired', 'broken']).gte('at', startIso(first)).lt('at', endIso(last)),
    supabase.from('vouchers').select('allocated_cost').gte('created_at', startIso(cs)).lt('created_at', endIso(ce)),
    supabase.from('vouchers').select('allocated_cost').in('status', ['available', 'reserved']),
    supabase.from('inventory_purchases').select('id, purchased_on, credits, amount_rp, note').gte('purchased_on', first).lte('purchased_on', last).order('purchased_on', { ascending: false }),
  ])
  type Ledger = { at: string; vouchers: { allocated_cost: number | null } | { allocated_cost: number | null }[] | null }
  const ledgerCost = (l: Ledger) => Number((Array.isArray(l.vouchers) ? l.vouchers[0] : l.vouchers)?.allocated_cost ?? 0)

  function pnl(s: string, e: string): Pnl {
    const os = (orders ?? []).filter((o) => { const x = jkt(o.confirmed_at); return x >= s && x <= e })
    const sum = (k: 'sell_price' | 'price_after_discount' | 'allocated_cost' | 'gross_profit' | 'extra_cost') => os.reduce((a, o) => a + Number(o[k]), 0)
    const expiredLoss = ((expiredLedger ?? []) as unknown as Ledger[]).filter((l) => { const x = jkt(l.at); return x >= s && x <= e }).reduce((a, l) => a + ledgerCost(l), 0)
    type Earn = { base_allowance: number; bonus: number; shifts: { shift_date: string } | { shift_date: string }[] }
    const payroll = ((earnings ?? []) as unknown as Earn[]).filter((x) => {
      const sd = (Array.isArray(x.shifts) ? x.shifts[0] : x.shifts)?.shift_date
      return sd >= s && sd <= e
    }).reduce((a, x) => a + Number(x.base_allowance) + Number(x.bonus), 0)
    const exp = (expenses ?? []).filter((x) => x.spent_on >= s && x.spent_on <= e).reduce((a, x) => a + x.amount_rp, 0)
    const gross = sum('gross_profit')
    const extraCost = sum('extra_cost')
    return {
      orders: os.length, review: os.filter((o) => o.needs_review).length,
      revenue: sum('sell_price'), merchant: sum('price_after_discount'), voucherCost: sum('allocated_cost'), gross,
      extraCost, expiredLoss, payroll, expenses: exp, net: gross - extraCost - expiredLoss - payroll - exp,
    }
  }

  const buckets = Array.from({ length: BUCKETS[p] }, (_, i) => {
    const anchor = shiftPeriod(p, d, i - (BUCKETS[p] - 1))
    const [s, e] = periodRange(p, anchor)
    const label = p === 'month'
      ? new Intl.DateTimeFormat('id-ID', { month: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(s + 'T12:00:00+07:00'))
      : `${s.slice(8, 10)}/${s.slice(5, 7)}`
    return { label, start: s, ...pnl(s, e) }
  })
  const current = pnl(cs, ce)

  // Alur persediaan untuk periode berjalan: modal masuk saat restock, jadi HPP hanya saat voucher terpakai.
  const inventoryIn = (vouchersIn ?? []).reduce((a, v) => a + Number(v.allocated_cost), 0)
  const onHand = (vouchersOnHand ?? []).reduce((a, v) => a + Number(v.allocated_cost), 0)
  const purchased = (purchases ?? []).filter((x) => x.purchased_on >= cs && x.purchased_on <= ce)

  return {
    current, buckets,
    flow: { purchased: purchased.reduce((a, x) => a + x.amount_rp, 0), inventoryIn, used: current.voucherCost, expired: current.expiredLoss, onHand },
    expenses: (expenses ?? []).filter((x) => x.spent_on >= cs && x.spent_on <= ce),
    purchases: purchased,
    ordersInPeriod: (orders ?? []).filter((o) => { const x = jkt(o.confirmed_at); return x >= cs && x <= ce }),
  }
}
