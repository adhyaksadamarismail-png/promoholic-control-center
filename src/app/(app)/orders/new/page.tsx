import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase/server'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, PageHeader, Pill, Table, inputCls } from '@/components/ui'
import { jktDateTime, rupiah } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/inventory'
import { cancelDraft, confirmDraft, requestCancel } from './actions'
import { OrderForm } from './order-form'

export const dynamic = 'force-dynamic'

export default async function NewOrderPage() {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
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
      .eq('admin_id', auth.user!.id)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase.from('approval_requests').select('target_id').eq('kind', 'order_cancel').eq('status', 'pending'),
  ])
  const pendingCancel = new Set((pending ?? []).map((p) => p.target_id))

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Transaksi Order" title="Catat order baru" />
      <OrderForm brands={brands ?? []} accounts={accounts ?? []} vouchers={vouchers ?? []} types={types ?? []} versions={versions ?? []} />

      <Card title="Order terakhir saya">
        <Table head={['Waktu', 'ID order', 'Customer', 'Voucher', 'Harga jual', 'Laba bersih', 'Status', '']} empty="Belum ada order.">
          {(orders ?? []).map((o) => {
            const v = (Array.isArray(o.vouchers) ? o.vouchers[0] : o.vouchers) as { code: string } | null
            const st = ORDER_STATUS[o.status]
            return (
              <tr key={o.id}>
                <td className="whitespace-nowrap">{jktDateTime(o.created_at)}</td>
                <td className="font-mono text-[13px] font-semibold">{o.code}</td>
                <td>{o.customer_name}</td>
                <td>
                  <Link href={`/accounts/${o.account_id}`} className="font-mono text-[13px] text-orange-700">{v?.code}</Link>
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
                <td>
                  {o.status === 'draft' && (
                    <div className="flex gap-1.5">
                      <ActionForm action={confirmDraft}>
                        <input type="hidden" name="order" value={o.id} />
                        <SubmitButton variant="success" className="min-h-9 px-3">Konfirmasi</SubmitButton>
                      </ActionForm>
                      <ActionForm action={cancelDraft} confirm="Batalkan draft ini? Voucher kembali tersedia.">
                        <input type="hidden" name="order" value={o.id} />
                        <SubmitButton variant="danger" className="min-h-9 px-3">Batalkan</SubmitButton>
                      </ActionForm>
                    </div>
                  )}
                  {o.status === 'confirmed' && !pendingCancel.has(o.id) && (
                    <details className="text-sm">
                      <summary className="cursor-pointer font-semibold text-orange-700">Ajukan batal</summary>
                      <ActionForm action={requestCancel} className="mt-2 flex w-60 flex-col gap-1.5">
                        <input type="hidden" name="order" value={o.id} />
                        <input name="reason" required minLength={3} placeholder="Alasan pembatalan" className={inputCls} />
                        <SubmitButton variant="ghost" className="min-h-9">Kirim ke owner</SubmitButton>
                      </ActionForm>
                    </details>
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
        <p className="text-xs text-ink-500">
          Order terkonfirmasi tidak bisa dihapus. Pembatalan diajukan ke owner; setelah disetujui voucher kembali tersedia lewat entri stok balik.
        </p>
      </Card>
    </div>
  )
}
