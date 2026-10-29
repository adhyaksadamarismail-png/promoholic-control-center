import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, PageHeader, Pill, Table, inputCls } from '@/components/ui'
import { jktDateTime, rupiah } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/inventory'
import { cancelDraft, confirmDraft, requestCancel } from './actions'
import { OrderForm } from './order-form'

export const dynamic = 'force-dynamic'

export default async function NewOrderPage() {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase, userId } = viewer
  const [{ data: brands }, { data: accounts }, { data: vouchers }, { data: types }, { data: versions }, { data: orders }, { data: pending }] = await Promise.all([
    supabase.from('brands').select('id, name').order('name'),
    // View tersamar: staf tidak melihat nomor akun lengkap / device VM.
    supabase.from('account_list').select('id, brand_id, account_code, source, active_until').order('account_code'),
    supabase.from('vouchers').select('id, code, account_id, voucher_type_id, grp, allocated_cost').eq('status', 'available'),
    supabase.from('voucher_types').select('id, brand_id, code, name, grp, sort_order').eq('is_active', true),
    supabase.from('voucher_type_versions').select('id, voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
    // RLS: staf hanya melihat order yang ia catat sendiri; owner melihat semua.
    supabase
      .from('orders')
      .select('id, code, account_id, customer_name, sell_price, net_profit, status, needs_review, review_reasons, created_at, vouchers(code)')
      .eq('admin_id', userId)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase.from('approval_requests').select('target_id').eq('kind', 'order_cancel').eq('status', 'pending'),
  ])
  const pendingCancel = new Set((pending ?? []).map((p) => p.target_id))
  // Voucher tambahan tanpa akun (restock "Baperan saja") ditampilkan sebagai pilihan "Baperan lepas" per brand.
  const brandOfType = (id: string) => types?.find((t) => t.id === id)?.brand_id ?? ''
  const vouchersWithLots = (vouchers ?? []).map((v) => (v.account_id ? v : { ...v, account_id: `lot:${brandOfType(v.voucher_type_id)}` }))
  const lotBrands = [...new Set(vouchersWithLots.filter((v) => v.account_id.startsWith('lot:')).map((v) => v.account_id.slice(4)))]
  const accountsWithLots = [
    ...lotBrands.map((b) => ({ id: `lot:${b}`, brand_id: b, account_code: 'Baperan lepas', source: 'panel' as const, active_until: null })),
    ...(accounts ?? []),
  ]
  const list = (orders ?? []).map((o) => ({
    o,
    v: (Array.isArray(o.vouchers) ? o.vouchers[0] : o.vouchers) as { code: string } | null,
    st: ORDER_STATUS[o.status],
  }))
  const actions = (o: { id: string; status: string }) => (
    <>
      {o.status === 'draft' && (
        <div className="flex gap-1.5">
          <ActionForm action={confirmDraft}>
            <input type="hidden" name="order" value={o.id} />
            <SubmitButton variant="success" className="min-h-10 px-3">Konfirmasi</SubmitButton>
          </ActionForm>
          <ActionForm action={cancelDraft} confirm="Batalkan draft ini? Voucher kembali tersedia.">
            <input type="hidden" name="order" value={o.id} />
            <SubmitButton variant="danger" className="min-h-10 px-3">Batalkan</SubmitButton>
          </ActionForm>
        </div>
      )}
      {o.status === 'confirmed' && !pendingCancel.has(o.id) && (
        <details className="text-sm">
          <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-orange-700">Ajukan batal</summary>
          <ActionForm action={requestCancel} className="mt-2 flex w-full max-w-60 flex-col gap-1.5">
            <input type="hidden" name="order" value={o.id} />
            <input name="reason" required minLength={3} placeholder="Alasan pembatalan" className={inputCls} />
            <SubmitButton variant="ghost" className="min-h-10">Kirim ke owner</SubmitButton>
          </ActionForm>
        </details>
      )}
    </>
  )

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Transaksi Order" title="Catat order baru" />
      <OrderForm brands={brands ?? []} accounts={accountsWithLots} vouchers={vouchersWithLots} types={types ?? []} versions={versions ?? []} />

      <Card title="Order terakhir saya">
        {/* HP: kartu per order; layar lebar: tabel. Aksi sama untuk keduanya. */}
        <ul className="flex flex-col divide-y divide-[#f1eadc] md:hidden">
          {list.map(({ o, v, st }) => (
            <li key={o.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-mono text-[13px] font-semibold">{o.code}</span>
                  <span className="text-xs text-ink-500">{jktDateTime(o.created_at)} · {o.customer_name}</span>
                </div>
                <span className="text-right">
                  <span className="block font-semibold">{rupiah(o.net_profit)}</span>
                  <span className="text-xs text-ink-500">jual {rupiah(o.sell_price)}</span>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Pill tone={st.tone}>{st.label}</Pill>
                {o.needs_review && <Pill tone="warning">Perlu tinjau owner</Pill>}
                {pendingCancel.has(o.id) && <Pill tone="warning">Batal diajukan</Pill>}
                {o.account_id ? (
                  <Link href={`/accounts/${o.account_id}`} className="ml-auto inline-flex min-h-8 items-center font-mono text-xs text-orange-700">{v?.code}</Link>
                ) : (
                  <span className="ml-auto font-mono text-xs text-ink-500">{v?.code}</span>
                )}
              </div>
              {actions(o)}
            </li>
          ))}
          {!list.length && <li className="py-3 text-sm text-ink-500">Belum ada order.</li>}
        </ul>
        <div className="hidden md:block">
          <Table head={['Waktu', 'ID order', 'Customer', 'Voucher', 'Harga jual', 'Laba bersih', 'Status', '']} empty="Belum ada order.">
            {list.map(({ o, v, st }) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap">{jktDateTime(o.created_at)}</td>
                <td className="whitespace-nowrap font-mono text-[13px] font-semibold">{o.code}</td>
                <td>{o.customer_name}</td>
                <td>
                  {o.account_id ? (
                    <Link href={`/accounts/${o.account_id}`} className="font-mono text-[13px] text-orange-700">{v?.code}</Link>
                  ) : (
                    <span className="font-mono text-[13px]">{v?.code}</span>
                  )}
                </td>
                <td>{rupiah(o.sell_price)}</td>
                <td className="font-semibold">{rupiah(o.net_profit)}</td>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {o.needs_review && <Pill tone="warning">Perlu tinjau owner</Pill>}
                    {pendingCancel.has(o.id) && <Pill tone="warning">Batal diajukan</Pill>}
                  </div>
                </td>
                <td>{actions(o)}</td>
              </tr>
            ))}
          </Table>
        </div>
        <p className="text-xs text-ink-500">
          Order terkonfirmasi tidak bisa dihapus. Pembatalan diajukan ke owner; setelah disetujui voucher kembali tersedia lewat entri stok balik.
        </p>
      </Card>
    </div>
  )
}
