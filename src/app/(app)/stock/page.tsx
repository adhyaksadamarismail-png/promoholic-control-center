import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase/server'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Stat, Table, Tabs, inputCls } from '@/components/ui'
import { addDays, jktDate, jktDateTime, weekStart } from '@/lib/format'
import { ACCOUNT_STATE, VOUCHER_STATUS } from '@/lib/inventory'
import { loadAccounts } from '@/lib/accounts'
import { loadTypeSummary } from '@/lib/stock'
import { decide } from '../approvals/actions'

export const dynamic = 'force-dynamic'

const TABS = [
  { key: 'jenis', label: 'Per jenis voucher' },
  { key: 'akun', label: 'Per akun' },
  { key: 'restock', label: 'Riwayat restock' },
  { key: 'koreksi', label: 'Koreksi stok' },
]
type Item = { type: string; qty: number }

export default async function StockPage({ searchParams }: { searchParams: Promise<{ tab?: string; brand?: string }> }) {
  const sp = await searchParams
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : 'jenis'
  const supabase = await createSessionClient()
  const { data: role } = await supabase.rpc('current_app_role')
  const isOwner = role === 'owner'
  const brandsRes = await supabase.from('brands').select('id, name').order('name')
  const brands = brandsRes.data ?? []
  const brand = brands.some((b) => b.id === sp.brand) ? sp.brand : undefined
  const weekFrom = `${weekStart(jktDate())}T00:00:00+07:00`

  const [summary, { count: weekRestocks }, { data: pendingAdj }] = await Promise.all([
    loadTypeSummary(supabase, brand),
    // RLS: staf hanya menghitung restock Panel.
    supabase.from('restocks').select('id', { count: 'exact', head: true }).gte('created_at', weekFrom),
    supabase.from('approval_requests').select('id').eq('kind', 'stock_adjust').eq('status', 'pending'),
  ])
  const sum = (k: 'available' | 'used' | 'reserved' | 'expired' | 'broken') => summary.reduce((a, s) => a + s[k], 0)
  const href = (t: string, b = brand) => `/stock?tab=${t}${b ? `&brand=${b}` : ''}`

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Satu inventaris · dua jalur restock (VM & Panel Admin)" title="Rekap Stok & Restock">
        <a href={`/stock/export${brand ? `?brand=${brand}` : ''}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Export CSV</a>
        <Link href="/panel" className="flex min-h-11 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Restock via Panel</Link>
      </PageHeader>

      <div className="flex flex-wrap gap-3">
        <Stat label="Tersedia" value={sum('available')} sub={brand ? brands.find((b) => b.id === brand)?.name : 'semua brand'} />
        <Stat label="Terpakai" value={sum('used')} />
        <Stat label="Dipesan (draft)" value={sum('reserved')} />
        <Stat label="Kedaluwarsa / rusak" value={sum('expired') + sum('broken')} />
        <Stat label="Restock minggu ini" value={weekRestocks ?? 0} sub={isOwner ? 'VM + Panel' : 'Panel'} />
        <Stat label="Koreksi menunggu" value={pendingAdj?.length ?? 0} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={href(tab, '')} className={`flex min-h-10 items-center rounded-full px-3.5 text-sm font-semibold ${!brand ? 'bg-navy-900 text-white' : 'border border-[#dcd2bf] bg-white'}`}>Semua brand</Link>
        {brands.map((b) => (
          <Link key={b.id} href={href(tab, b.id)} className={`flex min-h-10 items-center rounded-full px-3.5 text-sm font-semibold ${brand === b.id ? 'bg-navy-900 text-white' : 'border border-[#dcd2bf] bg-white'}`}>
            {b.name}
          </Link>
        ))}
      </div>

      <Tabs items={TABS.map((t) => ({ ...t, href: href(t.key) }))} active={tab} />

      {tab === 'jenis' && (
        <Card title="Stok per jenis voucher">
          <Table head={['Jenis voucher', 'Brand', 'Kelompok', 'Total masuk', 'Terpakai', 'Dipesan', 'Kedaluwarsa / rusak', 'Sisa', 'Ketentuan']} empty="Tidak ada data untuk brand ini.">
            {summary.map((s) => (
              <tr key={s.id}>
                <td className="font-semibold">{s.name} <span className="font-mono text-xs text-ink-500">{s.code}</span></td>
                <td>{brands.find((b) => b.id === s.brand_id)?.name}</td>
                <td>{s.grp === 'main' ? 'Utama' : 'Tambahan'}</td>
                <td>{s.total}</td>
                <td>{s.used}</td>
                <td>{s.reserved}</td>
                <td>{s.expired + s.broken}</td>
                <td className="font-display text-base font-bold">{s.available}</td>
                <td>{s.configured ? <span className="text-xs text-ink-500">{s.rule}</span> : <Pill tone="warning">Belum dikonfigurasi</Pill>}</td>
              </tr>
            ))}
          </Table>
          <Note>
            Sisa = masuk − terpakai − dipesan − kedaluwarsa/rusak, dari voucher yang tercatat di aplikasi ini. Angka tidak disinkronkan dari aplikasi brand;
            stok hanya berubah lewat restock, order, dan koreksi yang disetujui owner.
          </Note>
        </Card>
      )}

      {tab === 'akun' && <AccountsTab brand={brand} />}
      {tab === 'restock' && <RestockTab brand={brand} isOwner={isOwner} />}
      {tab === 'koreksi' && <CorrectionTab isOwner={isOwner} />}
    </div>
  )
}

async function AccountsTab({ brand }: { brand?: string }) {
  const supabase = await createSessionClient()
  const { brands, types, filtered } = await loadAccounts(supabase, { brand })
  return (
    <Card title="Sisa per akun">
      <Table head={['ID akun', 'Brand', 'Sumber', 'Sisa per jenis', 'Utama tersedia', 'Tambahan tersedia', 'Status', '']} empty="Tidak ada akun.">
        {filtered.map((r) => {
          const avail = r.vouchers.filter((v) => v.status === 'available')
          const byType = types
            .filter((t) => r.vouchers.some((v) => v.voucher_type_id === t.id))
            .map((t) => `${t.code} ${avail.filter((v) => v.voucher_type_id === t.id).length}/${r.vouchers.filter((v) => v.voucher_type_id === t.id).length}`)
          const st = ACCOUNT_STATE[r.state]
          return (
            <tr key={r.id}>
              <td className="whitespace-nowrap font-mono text-[13px] font-semibold">{r.account_code}</td>
              <td>{brands.find((b) => b.id === r.brand_id)?.name}</td>
              <td>{r.source === 'vm' ? 'VM' : 'Panel'}</td>
              <td className="text-xs">{byType.join(' · ')}</td>
              <td>{avail.filter((v) => v.grp === 'main').length}</td>
              <td>{avail.filter((v) => v.grp === 'extra').length}</td>
              <td><Pill tone={st.tone}>{st.label}</Pill></td>
              <td><Link href={`/accounts/${r.id}`} className="font-semibold text-orange-700">Detail</Link></td>
            </tr>
          )
        })}
      </Table>
    </Card>
  )
}

async function RestockTab({ brand, isOwner }: { brand?: string; isOwner: boolean }) {
  const supabase = await createSessionClient()
  const since = `${addDays(jktDate(), -30)}T00:00:00+07:00`
  const [{ data: restocks }, { data: accounts }, { data: profiles }, { data: vouchers }] = await Promise.all([
    supabase.from('restocks').select('id, code, source, account_id, vm_device_id, kind, items, created_by, created_at').gte('created_at', since).order('created_at', { ascending: false }),
    supabase.from('account_list').select('id, brand_id, account_code'),
    supabase.from('profiles').select('id, full_name'),
    supabase.from('vouchers').select('restock_id').gte('created_at', since),
  ])
  const acc = (id: string) => accounts?.find((a) => a.id === id)
  const rows = (restocks ?? []).filter((r) => !brand || acc(r.account_id)?.brand_id === brand)
  return (
    <>
      <Card title="Riwayat restock (30 hari)">
        <Table head={['ID restock', 'Sumber', 'ID akun', 'Jenis operasi', 'Jumlah per jenis', 'Waktu', 'Oleh', 'Hasil']} empty="Belum ada restock.">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-mono text-[13px] font-semibold">{r.code}</td>
              <td>{r.source === 'vm' ? `VM${r.vm_device_id ? ' · ' + r.vm_device_id : ''}` : 'Panel'}</td>
              <td className="whitespace-nowrap font-mono text-[13px]">
                <Link href={`/accounts/${r.account_id}`}>{acc(r.account_id)?.account_code}</Link>
              </td>
              <td>{r.kind === 'new_account' ? 'Akun baru' : 'Tambah voucher'}</td>
              <td>{(r.items as Item[]).map((i) => `${i.type}×${i.qty}`).join(', ')}</td>
              <td className="whitespace-nowrap">{jktDateTime(r.created_at)}</td>
              <td>{profiles?.find((p) => p.id === r.created_by)?.full_name ?? '—'}</td>
              <td><Pill tone="success">{(vouchers ?? []).filter((v) => v.restock_id === r.id).length} voucher masuk</Pill></td>
            </tr>
          ))}
        </Table>
        {!isOwner && <p className="text-xs text-ink-500">Restock dari Virtual Machine hanya terlihat oleh owner.</p>}
      </Card>
      <Card title="Pencegahan duplikat">
        <ul className="flex flex-col gap-1.5 text-sm">
          {[
            'ID akun unik per brand; akun yang sudah ada hanya bisa ditambah voucher, tidak dibuat ulang.',
            'Voucher utama otomatis tidak pernah dibuat dua kali (slot unik per akun & jenis).',
            'Setiap kiriman form membawa kunci idempoten: tombol tertekan dua kali hanya menghasilkan satu restock.',
            'Nomor akun VM unik di seluruh inventaris.',
            'Histori stok hanya bisa ditambah, tidak bisa diubah atau dihapus.',
          ].map((g) => (
            <li key={g} className="flex gap-2"><span className="font-bold text-success-700">✓</span>{g}</li>
          ))}
        </ul>
      </Card>
    </>
  )
}

async function CorrectionTab({ isOwner }: { isOwner: boolean }) {
  const supabase = await createSessionClient()
  const { data: reqs } = await supabase
    .from('approval_requests')
    .select('id, target_id, payload, reason, status, requested_by, requested_at, decided_at, decision_note')
    .eq('kind', 'stock_adjust')
    .order('requested_at', { ascending: false })
    .limit(40)
  const ids = (reqs ?? []).map((r) => r.target_id)
  const [{ data: vouchers }, { data: profiles }] = await Promise.all([
    supabase.from('vouchers').select('id, code, status, account_id').in('id', ids),
    supabase.from('profiles').select('id, full_name'),
  ])
  const v = (id: string) => vouchers?.find((x) => x.id === id)
  const label = (s: string) => VOUCHER_STATUS[s as keyof typeof VOUCHER_STATUS]?.label ?? s
  return (
    <Card title="Koreksi stok">
      <Table head={['Voucher', 'Perubahan', 'Alasan', 'Diajukan', 'Status', '']} empty="Belum ada pengajuan koreksi stok.">
        {(reqs ?? []).map((r) => (
          <tr key={r.id}>
            <td className="font-mono text-[13px]">
              {v(r.target_id) ? <Link href={`/accounts/${v(r.target_id)!.account_id}`}>{v(r.target_id)!.code}</Link> : '—'}
            </td>
            <td>{r.status === 'pending' ? `${label(v(r.target_id)?.status ?? '')} → ` : '→ '}{label((r.payload as { new_status: string }).new_status)}</td>
            <td>{r.reason}</td>
            <td className="whitespace-nowrap">{profiles?.find((p) => p.id === r.requested_by)?.full_name} · {jktDateTime(r.requested_at)}</td>
            <td>
              <Pill tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'danger'}>
                {r.status === 'pending' ? 'Menunggu' : r.status === 'approved' ? 'Disetujui' : 'Ditolak'}
              </Pill>
              {r.decision_note && <div className="text-xs text-ink-500">{r.decision_note}</div>}
            </td>
            <td>
              {isOwner && r.status === 'pending' && (
                <ActionForm action={decide} className="flex w-56 flex-col gap-1.5">
                  <input type="hidden" name="request" value={r.id} />
                  <input name="note" placeholder="Catatan (opsional)" className={inputCls} />
                  <div className="flex gap-1.5">
                    <SubmitButton name="decision" value="approve" variant="success" className="min-h-9 px-3">Setujui</SubmitButton>
                    <SubmitButton name="decision" value="reject" variant="danger" className="min-h-9 px-3">Tolak</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Note>Koreksi diajukan dari Detail Akun. Setelah disetujui, perubahan dicatat sebagai entri baru di histori stok; entri lama tidak diubah.</Note>
    </Card>
  )
}
