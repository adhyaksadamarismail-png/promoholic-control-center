import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/auth'
import { Card, Note, PageHeader, Table, Tabs } from '@/components/ui'
import { jktDate, jktTime } from '@/lib/format'
import { PanelForm } from './panel-form'
import { BulkRestock } from '@/components/bulk-restock'
import { BatchHistory } from '@/components/batch-history'
import { ExtraRestockForm } from './extra-form'
import { accountKey } from '@/lib/inventory'

export const dynamic = 'force-dynamic'

type Item = { type: string; qty: number }

export default async function PanelPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const m = (await searchParams).mode
  const mode = m === 'add' || m === 'extra' || m === 'bulk' ? m : 'new'
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase, isOwner } = viewer
  // Sama dengan can_restock_panel(): owner, atau staf aktif yang diberi izin. Fungsi restock memeriksa ulang di database.
  const allowed = isOwner || viewer.profile.can_restock_panel

  if (!allowed)
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <PageHeader eyebrow="Jalur restock kedua" title="Panel Admin & Restock" />
        <Note tone="warning">Akun Anda belum punya izin restock Panel Admin. Minta owner memberi izin di menu Absensi & Staf → Akun staf.</Note>
      </div>
    )

  const today = jktDate()
  const nowIso = new Date().toISOString()
  const [{ data: brands }, { data: types }, { data: versions }, { data: accounts }, { data: vouchers }, { data: costs }, { data: credit }, { data: todays }, { data: profiles }] =
    await Promise.all([
      supabase.from('brands').select('id, name').order('name'),
      supabase.from('voucher_types').select('id, brand_id, code, name, grp, auto_per_account, sort_order').eq('is_active', true),
      supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
      supabase.from('account_list').select('id, brand_id, account_code, source').order('account_code'),
      supabase.from('vouchers').select('account_id, voucher_type_id, slot'),
      supabase.from('brand_costs').select('brand_id, basis, credits_per_account, rp_per_voucher, effective_from').lte('effective_from', nowIso).order('effective_from', { ascending: false }),
      supabase.from('credit_prices').select('rp_per_credit').lte('effective_from', nowIso).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
      // RLS: staf hanya melihat restock bersumber Panel.
      supabase.from('restocks').select('id, code, account_id, kind, items, created_by, created_at').eq('source', 'panel').gte('created_at', `${today}T00:00:00+07:00`).order('created_at', { ascending: false }),
      supabase.from('profiles').select('id, full_name'),
    ])

  const maxSlots: Record<string, number> = {}
  ;(vouchers ?? []).forEach((v) => {
    const k = `${v.account_id}|${v.voucher_type_id}`
    maxSlots[k] = Math.max(maxSlots[k] ?? 0, v.slot)
  })
  // Versi modal yang berlaku per brand: baris pertama per brand karena diurutkan dari yang terbaru.
  const latest = (brands ?? []).map((b) => (costs ?? []).find((c) => c.brand_id === b.id)).filter((c) => !!c)
  const RESTOCK_KIND: Record<string, string> = { new_account: 'Akun baru', add_stock: 'Tambah voucher', extra_only: 'Baperan saja' }
  const codeOf = (id: string) => accounts?.find((a) => a.id === id)?.account_code ?? '—'

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Jalur restock kedua · staf berizin & owner" title="Panel Admin & Restock" />
      <Note>Nomor akun & virtual device tidak diperlukan di sini. Akun VM hanya bisa diubah owner di modul Virtual Machine.</Note>
      <Tabs
        items={[
          { key: 'new', label: 'Akun baru', href: '/panel' },
          { key: 'add', label: 'Tambah voucher ke akun yang ada', href: '/panel?mode=add' },
          { key: 'extra', label: 'Restock Baperan saja', href: '/panel?mode=extra' },
          { key: 'bulk', label: 'Bulk Restock', href: '/panel?mode=bulk' },
        ]}
        active={mode}
      />
      {mode === 'bulk' ? (
        <>
          <BulkRestock
            source="panel"
            brands={brands ?? []}
            costMissing={(brands ?? []).filter((b) => !latest.some((c) => c.brand_id === b.id)).map((b) => b.id)}
            isOwner={isOwner}
            autoTypes={types ?? []}
          />
          <BatchHistory source="panel" />
        </>
      ) : mode === 'extra' ? (
        <ExtraRestockForm
          brands={brands ?? []}
          types={(types ?? []).filter((t) => t.grp === 'extra' && t.auto_per_account === null)}
          versions={versions ?? []}
          accounts={(accounts ?? []).filter((a) => a.source === 'panel')}
          today={today}
        />
      ) : (
      <PanelForm
        key={mode}
        mode={mode}
        brands={brands ?? []}
        types={types ?? []}
        versions={versions ?? []}
        accounts={(accounts ?? []).filter((a) => a.source === 'panel')}
        existingKeys={(accounts ?? []).map((a) => `${a.brand_id}|${accountKey(a.brand_id, a.account_code)}`)}
        maxSlots={maxSlots}
        costs={latest}
        creditPrice={credit?.rp_per_credit ?? null}
        isOwner={isOwner}
      />
      )}

      <Card title="Restock Panel hari ini">
        <Table head={['ID', 'Akun', 'Jenis operasi', 'Per jenis', 'Waktu', 'Oleh']} empty="Belum ada restock Panel hari ini.">
          {(todays ?? []).map((r) => (
            <tr key={r.id}>
              <td className="font-mono text-[13px] font-semibold">{r.code}</td>
              <td className="font-mono text-[13px]">{r.account_id ? codeOf(r.account_id) : 'Tanpa akun'}</td>
              <td>{RESTOCK_KIND[r.kind] ?? r.kind}</td>
              <td>{(r.items as Item[]).map((i) => `${i.type}×${i.qty}`).join(', ')}</td>
              <td>{jktTime(r.created_at)}</td>
              <td>{profiles?.find((p) => p.id === r.created_by)?.full_name ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}
