import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { createSessionClient } from '@/lib/supabase/server'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Table, inputCls } from '@/components/ui'
import { dateLabel, jktDate, jktDateTime } from '@/lib/format'
import { ACCOUNT_STATE, LEDGER_REASON, VOUCHER_STATUS, accountState, currentVersion, ruleLabel, type Rule, type VoucherStatus } from '@/lib/inventory'
import { requestStockAdjust } from './actions'

export const dynamic = 'force-dynamic'

type Usage = { id: string; voucher_id: string; customer_name: string; customer_wa: string; admin_name: string; order_code: string; used_at: string; reversed_at: string | null }
type Voucher = { id: string; code: string; voucher_type_id: string; grp: 'main' | 'extra'; slot: number; status: VoucherStatus; allocated_cost: number }

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) notFound()
  const supabase = await createSessionClient()
  const [{ data: role }, { data: account }, { data: vdata }] = await Promise.all([
    supabase.rpc('current_app_role'),
    supabase.from('account_list').select('*').eq('id', id).maybeSingle(),
    supabase.from('vouchers').select('id, code, voucher_type_id, grp, slot, status, allocated_cost').eq('account_id', id),
  ])
  if (!account) notFound()
  const isOwner = role === 'owner'
  const vouchers = (vdata ?? []) as Voucher[]
  const vIds = vouchers.map((v) => v.id)

  const [{ data: brand }, { data: types }, { data: versions }, { data: usages }, { data: ledger }, { data: restocks }, { data: profiles }, { data: pending }] = await Promise.all([
    supabase.from('brands').select('name').eq('id', account.brand_id).single(),
    supabase.from('voucher_types').select('id, code, name, grp, sort_order').eq('brand_id', account.brand_id),
    supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
    // View tersamar: WhatsApp customer hanya terlihat penuh untuk owner dan admin yang mencatat.
    supabase.from('voucher_usage_list').select('*').in('voucher_id', vIds).order('used_at', { ascending: false }),
    supabase.from('stock_ledger').select('id, voucher_id, delta, reason, status_after, ref, actor_id, at').eq('account_id', id).order('at', { ascending: false }).limit(50),
    supabase.from('restocks').select('code, kind, created_at, items').eq('account_id', id).order('created_at'),
    supabase.from('profiles').select('id, full_name'),
    supabase.from('approval_requests').select('target_id').eq('kind', 'stock_adjust').eq('status', 'pending').in('target_id', vIds),
  ])
  const typeOf = (tid: string) => types?.find((t) => t.id === tid)
  const ruleOf = (tid: string) => currentVersion((versions ?? []) as (Rule & { voucher_type_id: string; effective_from: string })[], tid) ?? null
  const usageOf = (vid: string) => (usages as Usage[] | null)?.find((u) => u.voucher_id === vid && !u.reversed_at)
  const reversedOf = (vid: string) => (usages as Usage[] | null)?.filter((u) => u.voucher_id === vid && u.reversed_at) ?? []
  const codeOf = (vid: string) => vouchers.find((v) => v.id === vid)?.code
  const nameOf = (pid: string | null) => profiles?.find((p) => p.id === pid)?.full_name ?? 'Sistem'
  const pendingSet = new Set((pending ?? []).map((p) => p.target_id))
  const sort = (a: Voucher, b: Voucher) => (typeOf(a.voucher_type_id)?.sort_order ?? 0) - (typeOf(b.voucher_type_id)?.sort_order ?? 0) || a.slot - b.slot
  const main = vouchers.filter((v) => v.grp === 'main').sort(sort)
  const extra = vouchers.filter((v) => v.grp === 'extra').sort(sort)
  const state = ACCOUNT_STATE[accountState(account.needs_review, vouchers.map((v) => v.status))]
  const mainAvail = main.filter((v) => v.status === 'available').length

  const adjustForm = (v: Voucher) =>
    ['available', 'expired', 'broken'].includes(v.status) &&
    (pendingSet.has(v.id) ? (
      <span className="text-xs font-semibold text-warning-700">Koreksi stok menunggu owner</span>
    ) : (
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-semibold text-orange-700">Ajukan koreksi stok</summary>
        <ActionForm action={requestStockAdjust} className="mt-2 flex flex-col gap-1.5">
          <input type="hidden" name="voucher" value={v.id} />
          <select name="new_status" className={inputCls} defaultValue={v.status === 'available' ? 'broken' : 'available'}>
            <option value="available">Tersedia</option>
            <option value="broken">Rusak / tidak bisa dipakai</option>
            <option value="expired">Kedaluwarsa</option>
          </select>
          <input name="reason" required minLength={3} placeholder="Alasan" className={inputCls} />
          <SubmitButton variant="ghost" className="min-h-9">Kirim ke owner</SubmitButton>
        </ActionForm>
      </details>
    ))

  const info: [string, React.ReactNode][] = [
    ['Brand', brand?.name],
    ['Sumber', account.source === 'vm' ? 'Virtual Machine' : 'Panel Admin'],
    ...(account.source === 'vm' ? ([['Nomor akun', <span key="n" className="font-mono">{account.account_number}</span>]] as [string, React.ReactNode][]) : []),
    ...(isOwner && account.vm_device_id ? ([['Device', account.vm_device_id]] as [string, React.ReactNode][]) : []),
    ['Masuk', jktDateTime(account.entered_at)],
    ['Aktif s/d', account.active_until ? dateLabel(account.active_until) : '—'],
    ['Restock', restocks?.map((r) => r.code).join(', ') || (account.source === 'vm' && !isOwner ? 'Hanya owner' : '—')],
  ]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <nav className="text-sm text-ink-500">
        <Link href="/accounts" className="font-semibold text-orange-700">Daftar Akun</Link> / Detail akun
      </nav>
      <PageHeader title={account.account_code}>
        <Pill tone={state.tone}>{state.label}</Pill>
        {account.active_until && account.active_until < jktDate() && <Pill tone="danger">Masa aktif lewat</Pill>}
      </PageHeader>

      <dl className="grid grid-cols-2 gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6">
        {info.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">{k}</dt>
            <dd className="text-sm font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {account.needs_review && <Note tone="warning">Perlu diperiksa: {account.review_note ?? 'ditandai owner'}</Note>}

      <Card title={`Voucher utama (${main.length})`} aside={<span className="text-sm text-ink-500">{mainAvail} dari {main.length} tersedia</span>}>
        <div className="grid gap-3 md:grid-cols-3">
          {main.map((v, i) => {
            const t = typeOf(v.voucher_type_id)
            const u = usageOf(v.id)
            const st = VOUCHER_STATUS[v.status]
            return (
              <article key={v.id} className={`flex flex-col gap-2 rounded-xl border p-4 ${v.status === 'available' ? 'border-success-700/40' : 'border-cream-300'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">Kolom {i + 1} · {t?.code}</span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </div>
                <span className="font-display text-base font-semibold">{t?.name}</span>
                <span className="text-xs text-ink-500">{ruleLabel(ruleOf(v.voucher_type_id))}</span>
                <span className="font-mono text-xs">{v.code}</span>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-[#f1eadc] pt-2 text-sm">
                  <dt className="text-ink-500">Customer</dt><dd className="font-semibold">{u?.customer_name ?? '—'}</dd>
                  <dt className="text-ink-500">WhatsApp</dt><dd className="font-mono text-[13px]">{u?.customer_wa ?? '—'}</dd>
                  <dt className="text-ink-500">ID order</dt><dd className="font-mono text-[13px]">{u?.order_code ?? '—'}</dd>
                  <dt className="text-ink-500">Waktu pakai</dt><dd>{u ? jktDateTime(u.used_at) : '—'}</dd>
                  <dt className="text-ink-500">Admin</dt><dd>{u?.admin_name ?? '—'}</dd>
                </dl>
                {reversedOf(v.id).map((r) => (
                  <span key={r.id} className="text-xs text-ink-500">Pernah dipakai {r.order_code}, dibatalkan {jktDateTime(r.reversed_at)}</span>
                ))}
                {adjustForm(v)}
              </article>
            )
          })}
        </div>
        {!main.length && <p className="text-sm text-ink-500">Belum ada voucher utama.</p>}
      </Card>

      <Card title="Voucher tambahan">
        {extra.length ? (
          <Table head={['ID voucher', 'Ketentuan', 'Status', 'Customer', 'WhatsApp', 'ID order', 'Waktu pakai', 'Admin', '']}>
            {extra.map((v) => {
              const u = usageOf(v.id)
              const st = VOUCHER_STATUS[v.status]
              return (
                <tr key={v.id}>
                  <td className="font-mono text-[13px]">{v.code}</td>
                  <td className="text-ink-500">{typeOf(v.voucher_type_id)?.name} · {ruleLabel(ruleOf(v.voucher_type_id))}</td>
                  <td><Pill tone={st.tone}>{st.label}</Pill></td>
                  <td>{u?.customer_name ?? '—'}</td>
                  <td className="font-mono text-[13px]">{u?.customer_wa ?? '—'}</td>
                  <td className="font-mono text-[13px]">{u?.order_code ?? '—'}</td>
                  <td>{u ? jktDateTime(u.used_at) : '—'}</td>
                  <td>{u?.admin_name ?? '—'}</td>
                  <td>{adjustForm(v)}</td>
                </tr>
              )
            })}
          </Table>
        ) : (
          <p className="text-sm text-ink-500">Akun ini tidak memiliki voucher tambahan. Voucher tambahan hanya dicatat bila memang tersedia di akun.</p>
        )}
      </Card>

      <Card title="Riwayat akun">
        <Table head={['Waktu', 'Peristiwa', 'Voucher', 'Stok', 'Oleh', 'Referensi']} empty="Belum ada riwayat.">
          {(ledger ?? []).map((l) => (
            <tr key={l.id}>
              <td className="whitespace-nowrap">{jktDateTime(l.at)}</td>
              <td>{LEDGER_REASON[l.reason] ?? l.reason} → {VOUCHER_STATUS[l.status_after as VoucherStatus]?.label}</td>
              <td className="font-mono text-[13px]">{codeOf(l.voucher_id)}</td>
              <td className={l.delta > 0 ? 'text-success-700' : l.delta < 0 ? 'text-danger-700' : 'text-ink-500'}>{l.delta > 0 ? '+1' : l.delta < 0 ? '−1' : '0'}</td>
              <td>{nameOf(l.actor_id)}</td>
              <td className="font-mono text-[13px]">{l.ref ?? '—'}</td>
            </tr>
          ))}
        </Table>
        <p className="text-xs text-ink-500">Riwayat stok hanya bisa ditambah, tidak bisa diubah atau dihapus.</p>
      </Card>
    </div>
  )
}
