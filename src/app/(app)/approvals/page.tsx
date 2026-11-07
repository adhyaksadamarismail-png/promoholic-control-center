import { requireOwnerPage } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import Link from 'next/link'
import { Card, EmptyState, Note, PageHeader, Pill, Tabs, inputCls, type Accent, ACCENTS } from '@/components/ui'
import { Icon, type IconName } from '@/components/icons'
import { jktDateTime, rupiah } from '@/lib/format'
import { KIND_LABEL, type AttendanceKind } from '@/lib/attendance'
import { decide } from './actions'

export const dynamic = 'force-dynamic'

const KIND: Record<string, string> = {
  order_review: 'Tinjauan order',
  order_cancel: 'Pembatalan order',
  stock_adjust: 'Koreksi stok voucher',
  attendance_fix: 'Koreksi absensi',
  benefit_fix: 'Pembatalan klaim benefit',
}
const KIND_ICON: Record<string, { icon: IconName; accent: Accent }> = {
  order_review: { icon: 'receipt', accent: 'sky' },
  order_cancel: { icon: 'cart', accent: 'peach' },
  stock_adjust: { icon: 'box', accent: 'lavender' },
  attendance_fix: { icon: 'clock', accent: 'mint' },
  benefit_fix: { icon: 'coffee', accent: 'navy' },
}
const PAGE = 30
const VOUCHER_STATUS: Record<string, string> = { available: 'Tersedia', expired: 'Kedaluwarsa', broken: 'Rusak', used: 'Terpakai', reserved: 'Dipesan' }

const DECISION: Record<string, { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
  approved: { label: 'Disetujui', tone: 'success' },
  rejected: { label: 'Ditolak', tone: 'danger' },
  closed: { label: 'Ditutup', tone: 'neutral' },
}

type Req = {
  id: string; kind: string; target_id: string; payload: Record<string, string>; reason: string; status: string
  requested_by: string; requested_at: string; decided_at: string | null; decision_note: string | null
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ tab?: string; jenis?: string; status?: string; page?: string }> }) {
  const supabase = await requireOwnerPage()
  const sp = await searchParams
  const tab = sp.tab === 'riwayat' ? 'riwayat' : 'menunggu'
  const jenis = sp.jenis && KIND[sp.jenis] ? sp.jenis : undefined
  const decided = sp.status && DECISION[sp.status] ? sp.status : undefined
  const page = Math.max(1, Number(sp.page) || 1)
  let hq = supabase.from('approval_requests').select('*', { count: 'exact' }).neq('status', 'pending').order('decided_at', { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1)
  if (jenis) hq = hq.eq('kind', jenis)
  if (decided) hq = hq.eq('status', decided)
  const [{ data: allPending }, { data: recent, count: historyCount }, { data: profiles }] = await Promise.all([
    supabase.from('approval_requests').select('*').eq('status', 'pending').order('requested_at'),
    tab === 'riwayat' ? hq : Promise.resolve({ data: [] as Req[], count: 0 }),
    supabase.from('profiles').select('id, full_name'),
  ])
  const pending = (allPending ?? []).filter((r) => !jenis || r.kind === jenis)
  const pendingByKind = Object.keys(KIND).map((k) => ({ k, n: (allPending ?? []).filter((r) => r.kind === k).length }))
  const link = (o: Record<string, string | undefined>) => {
    const u = new URLSearchParams(Object.entries({ tab: tab === 'riwayat' ? 'riwayat' : undefined, jenis, status: decided, ...o }).filter(([, v]) => v) as [string, string][])
    const q = u.toString()
    return `/approvals${q ? '?' + q : ''}`
  }
  const pages = Math.max(1, Math.ceil((historyCount ?? 0) / PAGE))
  const all = [...pending, ...(recent ?? [])] as Req[]
  const ids = (k: string) => all.filter((r) => r.kind === k).map((r) => r.target_id)

  // Detail target per jenis pengajuan, diambil sekali per jenis.
  const [{ data: orders }, { data: vouchers }, { data: shifts }, { data: claims }] = await Promise.all([
    supabase.from('orders')
      .select('id, code, admin_id, customer_name, menu_price, discount, price_after_discount, sell_price, net_profit, status, created_at, vouchers(code)')
      .in('id', [...ids('order_cancel'), ...ids('order_review')]),
    supabase.from('vouchers').select('id, code, status').in('id', ids('stock_adjust')),
    supabase.from('shifts').select('id, code, planned_start, planned_end').in('id', ids('attendance_fix')),
    supabase.from('benefit_claims').select('id, claimed_at, benefit_entitlements(shifts(code))').in('id', ids('benefit_fix')),
  ])
  const name = (id: string) => profiles?.find((p) => p.id === id)?.full_name ?? '—'

  function target(r: Req) {
    if (r.kind === 'order_cancel' || r.kind === 'order_review') {
      const o = orders?.find((x) => x.id === r.target_id)
      return o ? `${o.code} · ${o.customer_name} · ${rupiah(o.sell_price)} · dibuat ${jktDateTime(o.created_at)}` : 'Order'
    }
    if (r.kind === 'stock_adjust') {
      const v = vouchers?.find((x) => x.id === r.target_id)
      return `${v?.code ?? 'Voucher'}: ${VOUCHER_STATUS[v?.status ?? ''] ?? v?.status} → ${VOUCHER_STATUS[r.payload.new_status] ?? r.payload.new_status}`
    }
    if (r.kind === 'attendance_fix') {
      const s = shifts?.find((x) => x.id === r.target_id)
      return `${s?.code ?? 'Shift'} · ${KIND_LABEL[r.payload.kind as AttendanceKind] ?? r.payload.kind} menjadi ${jktDateTime(r.payload.at)}`
    }
    const c = claims?.find((x) => x.id === r.target_id) as { claimed_at: string; benefit_entitlements: { shifts: { code: string } } } | undefined
    return `Klaim ${c?.benefit_entitlements?.shifts?.code ?? ''} · ${jktDateTime(c?.claimed_at)}`
  }

  /** Rincian transaksi yang ditinjau: harga hitungan voucher dibandingkan dengan yang dicatat. */
  function orderDetail(id: string) {
    const o = orders?.find((x) => x.id === id)
    if (!o) return null
    const v = (Array.isArray(o.vouchers) ? o.vouchers[0] : o.vouchers) as { code: string } | null
    const expected = o.menu_price - o.discount
    const gap = o.price_after_discount - expected
    const rows: [string, string][] = [
      ['Dicatat oleh', name(o.admin_id)],
      ['Voucher', v?.code ?? '—'],
      ['Harga menu', rupiah(o.menu_price)],
      ['Potongan voucher', rupiah(o.discount)],
      ['Harga merchant (hitungan)', rupiah(expected)],
      ['Harga merchant (dicatat)', rupiah(o.price_after_discount)],
      ['Selisih', gap ? `${gap > 0 ? '+' : '−'}${rupiah(Math.abs(gap))}` : 'Tidak ada'],
      ['Harga jual', rupiah(o.sell_price)],
      ['Laba bersih', rupiah(o.net_profit)],
    ]
    return (
      <details className="rounded-lg bg-cream-50 px-3 py-2 text-sm">
        <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-orange-700">Lihat detail transaksi</summary>
        <dl className="mt-1 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {rows.map(([k, val]) => (
            <div key={k} className="flex justify-between gap-3 border-t border-[#f1eadc] py-1.5">
              <dt className="text-ink-500">{k}</dt>
              <dd className="text-right font-semibold">{val}</dd>
            </div>
          ))}
        </dl>
      </details>
    )
  }

  const KindTile = ({ kind }: { kind: string }) => (
    <span className={`icon-tile size-10 shrink-0 ${ACCENTS[KIND_ICON[kind]?.accent ?? 'navy']}`}>
      <Icon name={KIND_ICON[kind]?.icon ?? 'shield'} className="size-5" />
    </span>
  )

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <PageHeader eyebrow="Hanya owner · keputusan tercatat di audit log" title="Persetujuan" />

      <Tabs
        items={[
          { key: 'menunggu', label: 'Menunggu', href: link({ tab: undefined, status: undefined, page: undefined }), badge: allPending?.length ?? 0 },
          { key: 'riwayat', label: 'Riwayat keputusan', href: link({ tab: 'riwayat', page: undefined }) },
        ]}
        active={tab}
      />

      <nav aria-label="Filter jenis pengajuan" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <Link
          href={link({ jenis: undefined, page: undefined })}
          scroll={false}
          aria-current={!jenis ? 'true' : undefined}
          className={`btn-press flex min-h-9 shrink-0 items-center rounded-full border px-3.5 text-sm font-semibold ${!jenis ? 'border-navy-900 bg-navy-900 text-white' : 'border-cream-300 bg-white text-ink-500 hover:text-navy-900'}`}
        >
          Semua jenis
        </Link>
        {pendingByKind.map(({ k, n }) => (
          <Link
            key={k}
            href={link({ jenis: k, page: undefined })}
            scroll={false}
            aria-current={jenis === k ? 'true' : undefined}
            className={`btn-press flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold ${jenis === k ? 'border-navy-900 bg-navy-900 text-white' : 'border-cream-300 bg-white text-ink-500 hover:text-navy-900'}`}
          >
            <Icon name={KIND_ICON[k].icon} className="size-4" />
            {KIND[k]}
            {tab === 'menunggu' && !!n && <span className="rounded-full bg-orange-500 px-1.5 text-[11px] font-bold leading-5 text-navy-900">{n}</span>}
          </Link>
        ))}
      </nav>

      {tab === 'menunggu' && (
        <>
          {!pending.length ? (
            <EmptyState title={jenis ? `Tidak ada ${KIND[jenis].toLowerCase()} yang menunggu` : 'Semua pengajuan sudah diputuskan'} icon="check">
              Pengajuan baru dari staf dan order yang ditandai sistem akan muncul di sini.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {(pending as Req[]).map((r) => (
                <li key={r.id} data-reveal className="card-hover flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <KindTile kind={r.kind} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-display text-base font-semibold">{KIND[r.kind]}</span>
                        <Pill tone="warning">Menunggu</Pill>
                      </div>
                      <span className="text-sm [overflow-wrap:anywhere]">{target(r)}</span>
                      <span className="text-xs text-ink-500">
                        {r.kind === 'order_review' ? 'Dicatat' : 'Diajukan'} {name(r.requested_by)} · {jktDateTime(r.requested_at)}
                      </span>
                    </div>
                  </div>
                  <blockquote className="rounded-xl border-l-4 border-orange-500 bg-cream-50 px-3.5 py-2.5 text-sm">
                    <span className="block text-xs font-semibold text-ink-500">{r.kind === 'order_review' ? 'Ditandai sistem' : 'Alasan pengajuan'}</span>
                    “{r.reason}”
                  </blockquote>
                  {r.kind === 'order_review' && orderDetail(r.target_id)}
                  <ActionForm action={decide} className="flex flex-col gap-2 border-t border-[#f3ede2] pt-3 sm:flex-row sm:items-start">
                    <input type="hidden" name="request" value={r.id} />
                    <input name="note" placeholder={r.kind === 'order_review' ? 'Catatan (wajib bila menolak)' : 'Catatan keputusan (opsional)'} aria-label="Catatan keputusan" className={`${inputCls} flex-1 text-base sm:text-sm`} />
                    <div className="grid grid-cols-2 gap-2 sm:flex">
                      <SubmitButton name="decision" value="approve" variant="success">Setujui</SubmitButton>
                      <SubmitButton name="decision" value="reject" variant="danger">Tolak</SubmitButton>
                    </div>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <Note>
            Menyetujui tidak menghapus data lama: pembatalan order mengembalikan voucher lewat entri stok balik, koreksi absensi
            menambah event koreksi, dan pembatalan klaim menandai klaim lama sebagai dibatalkan. Tinjauan order hanya mencatat keputusan:
            angka order, voucher, dan Keuangan tetap. Bila order yang ditolak harus dibatalkan, ajukan pembatalan dari Transaksi Order. Semua tercatat di audit log.
          </Note>
        </>
      )}

      {tab === 'riwayat' && (
        <Card
          title={`Riwayat keputusan (${historyCount ?? 0})`}
          aside={
            <nav aria-label="Filter keputusan" className="flex gap-1 rounded-xl bg-cream-100 p-1 text-xs font-semibold">
              {[{ k: undefined, l: 'Semua' }, ...Object.entries(DECISION).map(([k, v]) => ({ k, l: v.label }))].map((x) => (
                <Link key={x.l} href={link({ status: x.k, page: undefined })} scroll={false} aria-current={decided === x.k ? 'true' : undefined} className={`btn-press rounded-lg px-2.5 py-1.5 ${decided === x.k ? 'bg-white text-navy-900 shadow-sm' : 'text-ink-500'}`}>
                  {x.l}
                </Link>
              ))}
            </nav>
          }
        >
          {!recent?.length ? (
            <EmptyState title="Belum ada keputusan untuk filter ini" icon="history" />
          ) : (
            <ul className="flex flex-col">
              {(recent as Req[]).map((r) => (
                <li key={r.id} className="flex items-start gap-3 border-b border-[#f3ede2] py-3 last:border-0">
                  <KindTile kind={r.kind} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <b>{KIND[r.kind]}</b>
                      <Pill tone={DECISION[r.status]?.tone ?? 'neutral'}>{DECISION[r.status]?.label ?? r.status}</Pill>
                    </span>
                    <span className="[overflow-wrap:anywhere]">{target(r)}</span>
                    <span className="text-xs text-ink-500">
                      Diajukan {name(r.requested_by)} · {jktDateTime(r.requested_at)} · diputuskan {jktDateTime(r.decided_at)}
                    </span>
                    <span className="text-xs text-ink-500">Alasan: “{r.reason}”{r.decision_note ? ` · Catatan keputusan: ${r.decision_note}` : ''}</span>
                    {(r.kind === 'order_review' || r.kind === 'order_cancel') && orderDetail(r.target_id)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav aria-label="Halaman" className="flex items-center justify-between gap-2 text-sm">
              {page > 1 ? <Link href={link({ page: String(page - 1) })} scroll={false} className="btn-press rounded-lg border border-cream-300 bg-white px-3 py-2 font-semibold">← Sebelumnya</Link> : <span />}
              <span className="text-ink-500">Halaman {page} dari {pages}</span>
              {page < pages ? <Link href={link({ page: String(page + 1) })} scroll={false} className="btn-press rounded-lg border border-cream-300 bg-white px-3 py-2 font-semibold">Berikutnya →</Link> : <span />}
            </nav>
          )}
        </Card>
      )}
    </div>
  )
}
