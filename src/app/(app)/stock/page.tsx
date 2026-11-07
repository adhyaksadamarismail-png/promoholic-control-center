import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'
import { getViewer } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Stat, Table, Tabs, inputCls } from '@/components/ui'
import { addDays, dateLabel, jktDate, jktDateTime, rupiah, weekStart } from '@/lib/format'
import { ACCOUNT_STATE, VOUCHER_STATUS, stockLevel } from '@/lib/inventory'
import { Progress } from '@/components/motion'
import { Icon } from '@/components/icons'
import { loadAccounts } from '@/lib/accounts'
import { loadTypeSummary } from '@/lib/stock'
import { decide } from '../approvals/actions'
import { setRestockCost } from './actions'

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
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase, isOwner } = viewer
  // Kode brand divalidasi formatnya saja agar daftar brand tidak perlu ditunggu sebelum query lain; brand asing = hasil kosong.
  const brand = /^[A-Z]{2}$/.test(sp.brand ?? '') ? sp.brand : undefined
  const weekFrom = `${weekStart(jktDate())}T00:00:00+07:00`

  let accQ = supabase.from('account_list').select('id', { count: 'exact', head: true }).is('archived_at', null)
  if (brand) accQ = accQ.eq('brand_id', brand)
  const [{ data: brandRows }, summary, { count: weekRestocks }, { data: pendingAdj }, { count: accountCount }] = await Promise.all([
    supabase.from('brands').select('id, name').order('name'),
    loadTypeSummary(supabase, brand),
    // RLS: staf hanya menghitung restock Panel.
    supabase.from('restocks').select('id', { count: 'exact', head: true }).gte('created_at', weekFrom),
    supabase.from('approval_requests').select('id').eq('kind', 'stock_adjust').eq('status', 'pending'),
    accQ,
  ])
  const brands = brandRows ?? []
  const sum = (k: 'available' | 'used' | 'reserved' | 'expired' | 'broken') => summary.reduce((a, s) => a + s[k], 0)
  const href = (t: string, b = brand) => `/stock?tab=${t}${b ? `&brand=${b}` : ''}`

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Satu inventaris · dua jalur restock (VM & Panel Admin)" title="Rekap Stok & Restock">
        <a href={`/stock/export${brand ? `?brand=${brand}` : ''}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Export CSV</a>
        <Link href="/panel" className="flex min-h-11 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Restock via Panel</Link>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon="user" accent="sky" label="Akun" value={accountCount ?? 0} sub={brand ? brands.find((b) => b.id === brand)?.name : 'semua brand'} />
        <Stat icon="tag" accent="mint" label="Voucher utama tersedia" value={summary.filter((x) => x.grp === 'main').reduce((a, x) => a + x.available, 0)} />
        <Stat icon="layers" accent="lavender" label="Voucher tambahan tersedia" value={summary.filter((x) => x.grp === 'extra').reduce((a, x) => a + x.available, 0)} sub="mis. Baperan; dihitung per voucher, bukan per akun" />
        <Stat icon="cart" accent="peach" label="Terpakai" value={sum('used')} />
        <Stat icon="clock" accent="peach" label="Dipesan (draft)" value={sum('reserved')} />
        <Stat icon="alert" accent="navy" label="Kedaluwarsa / rusak" value={sum('expired') + sum('broken')} />
        <Stat icon="restock" accent="mint" label="Restock minggu ini" value={weekRestocks ?? 0} sub={isOwner ? 'VM + Panel' : 'Panel'} />
        <Stat icon="shield" accent="lavender" label="Koreksi menunggu" value={pendingAdj?.length ?? 0} />
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0 sm:pb-0">
        <Link href={href(tab, '')} scroll={false} aria-current={!brand ? 'true' : undefined} className={`btn-press flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-sm font-semibold ${!brand ? 'bg-navy-900 text-white' : 'border border-cream-300 bg-white text-ink-500 hover:text-navy-900'}`}>Semua brand</Link>
        {brands.map((b) => (
          <Link key={b.id} href={href(tab, b.id)} scroll={false} aria-current={brand === b.id ? 'true' : undefined} className={`btn-press flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-sm font-semibold ${brand === b.id ? 'bg-navy-900 text-white' : 'border border-cream-300 bg-white text-ink-500 hover:text-navy-900'}`}>
            {b.name}
          </Link>
        ))}
      </div>

      <Tabs items={TABS.map((t) => ({ ...t, href: href(t.key) }))} active={tab} />

      {tab === 'jenis' && (
        <Card title="Stok per jenis voucher">
          {!summary.length && <p className="text-sm text-ink-500">Tidak ada data untuk brand ini.</p>}
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:hidden">
            {summary.map((s) => (
              <li key={s.id} data-reveal className="flex flex-col gap-2 rounded-xl border border-cream-300 bg-white p-3.5 text-sm">
                <span className="flex items-start justify-between gap-2">
                  <span className="flex flex-col">
                    <b>{s.name} <span className="font-mono text-xs font-normal text-ink-500">{s.code}</span></b>
                    <span className="text-xs text-ink-500">{brands.find((b) => b.id === s.brand_id)?.name} · {s.grp === 'main' ? 'Utama' : 'Tambahan'}</span>
                  </span>
                  <span className="text-right">
                    <b className="font-display text-xl">{s.available}</b>
                    <span className="block text-xs text-ink-500">sisa dari {s.total}</span>
                  </span>
                </span>
                <Progress value={s.total ? (s.available / s.total) * 100 : 0} className="bg-gradient-to-r from-lavender-500 to-orange-500" label={`Sisa ${s.name}`} />
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
                  <span>Terpakai <b className="text-navy-900">{s.used}</b></span>
                  <span>Dipesan <b className="text-navy-900">{s.reserved}</b></span>
                  <span>Kedaluwarsa/rusak <b className="text-navy-900">{s.expired + s.broken}</b></span>
                </span>
                {s.configured ? <span className="text-xs text-ink-500">{s.rule}</span> : <span><Pill tone="warning">Belum dikonfigurasi</Pill></span>}
              </li>
            ))}
          </ul>
          <div className="hidden lg:block">
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
                <td className="min-w-28">
                  <span className="font-display text-base font-bold">{s.available}</span>
                  <span className="mt-1 block"><Progress value={s.total ? (s.available / s.total) * 100 : 0} className="bg-gradient-to-r from-lavender-500 to-orange-500" label={`Sisa ${s.name}`} /></span>
                </td>
                <td>{s.configured ? <span className="text-xs text-ink-500">{s.rule}</span> : <Pill tone="warning">Belum dikonfigurasi</Pill>}</td>
              </tr>
            ))}
          </Table>
          </div>
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
      {!filtered.length && <p className="text-sm text-ink-500">Tidak ada akun.</p>}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:hidden">
        {filtered.map((r) => {
          const avail = r.vouchers.filter((v) => v.status === 'available')
          const st = ACCOUNT_STATE[r.state]
          return (
            <li key={r.id}>
              <Link href={`/accounts/${r.id}`} className="card-hover flex flex-col gap-1.5 rounded-xl border border-cream-300 bg-white p-3.5 text-sm">
                <span className="flex items-center justify-between gap-2">
                  <b className="font-mono">{r.account_code}</b>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </span>
                <span className="text-xs text-ink-500">{brands.find((b) => b.id === r.brand_id)?.name} · {r.source === 'vm' ? 'VM' : 'Panel'}</span>
                <span className="flex items-center gap-2 text-xs">
                  <span aria-hidden className={`size-2 rounded-full ${avail.length === 0 ? 'bg-[#c9cdd6]' : stockLevel(avail.length) === 'menipis' ? 'bg-[#f5b544]' : 'bg-[#4fb286]'}`} />
                  <b>{avail.length}</b> tersedia · utama {avail.filter((v) => v.grp === 'main').length} · tambahan {avail.filter((v) => v.grp === 'extra').length}
                  {avail.length > 0 && stockLevel(avail.length) === 'menipis' && <span className="rounded-full bg-warning-100 px-2 py-0.5 text-[10px] font-bold text-warning-700">MENIPIS</span>}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="hidden lg:block">
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
      </div>
    </Card>
  )
}

const RESTOCK_KIND: Record<string, string> = { new_account: 'Akun baru + voucher utama', add_stock: 'Tambah ke akun', extra_only: 'Baperan saja' }

async function RestockTab({ brand, isOwner }: { brand?: string; isOwner: boolean }) {
  const supabase = await createSessionClient()
  const since = `${addDays(jktDate(), -30)}T00:00:00+07:00`
  const [{ data: restocks }, { data: accounts }, { data: profiles }, { data: vouchers }] = await Promise.all([
    supabase.from('restocks').select('id, code, source, account_id, brand_id, vm_device_id, kind, items, created_by, created_at, unit_cost, source_note, received_on').gte('created_at', since).order('created_at', { ascending: false }),
    supabase.from('account_list').select('id, brand_id, account_code'),
    supabase.from('profiles').select('id, full_name'),
    supabase.from('vouchers').select('restock_id').gte('created_at', since),
  ])
  const acc = (id: string | null) => accounts?.find((a) => a.id === id)
  const rows = (restocks ?? []).filter((r) => !brand || (r.brand_id ?? acc(r.account_id)?.brand_id) === brand)
  return (
    <>
      <Card title="Riwayat restock (30 hari)">
        {!rows.length && <p className="text-sm text-ink-500">Belum ada restock.</p>}
        <ul className="flex flex-col divide-y divide-[#f3ede2] lg:hidden">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 py-3 text-sm">
              <span className="flex items-center justify-between gap-2">
                <b className="font-mono text-[13px]">{r.code}</b>
                <Pill tone="success">{(vouchers ?? []).filter((v) => v.restock_id === r.id).length} voucher masuk</Pill>
              </span>
              <span>{RESTOCK_KIND[r.kind] ?? r.kind} · {(r.items as Item[]).map((i) => `${i.type}×${i.qty}`).join(', ')}</span>
              <span className="text-xs text-ink-500">
                {r.source === 'vm' ? `VM${r.vm_device_id ? ' · ' + r.vm_device_id : ''}` : 'Panel'} ·{' '}
                {r.account_id ? <Link href={`/accounts/${r.account_id}`} className="font-mono">{acc(r.account_id)?.account_code}</Link> : 'Tanpa akun'} · {jktDateTime(r.created_at)} · {profiles?.find((p) => p.id === r.created_by)?.full_name ?? '—'}
              </span>
              {r.kind === 'extra_only' && (
                <span className="text-xs">{r.unit_cost === null ? <Pill tone="warning">Modal belum diisi</Pill> : `${rupiah(r.unit_cost)} / voucher`}{r.source_note ? ` · ${r.source_note}` : ''}</span>
              )}
              {isOwner && r.kind === 'extra_only' && r.unit_cost === null && (
                <ActionForm action={setRestockCost} className="flex gap-1.5">
                  <input type="hidden" name="restock" value={r.id} />
                  <input name="unit_cost" inputMode="numeric" required placeholder="Rp/voucher" className={`${inputCls} w-32 text-base`} />
                  <SubmitButton variant="ghost" className="min-h-11 px-3">Isi</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
        <div className="hidden lg:block">
        <Table head={['ID restock', 'Sumber', 'ID akun', 'Jenis operasi', 'Jumlah per jenis', 'Modal / sumber', 'Waktu', 'Oleh', 'Hasil']} empty="Belum ada restock.">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-mono text-[13px] font-semibold">{r.code}</td>
              <td>{r.source === 'vm' ? `VM${r.vm_device_id ? ' · ' + r.vm_device_id : ''}` : 'Panel'}</td>
              <td className="whitespace-nowrap font-mono text-[13px]">
                {r.account_id ? <Link href={`/accounts/${r.account_id}`}>{acc(r.account_id)?.account_code}</Link> : <span className="text-ink-500">Tanpa akun</span>}
              </td>
              <td>{RESTOCK_KIND[r.kind] ?? r.kind}</td>
              <td>{(r.items as Item[]).map((i) => `${i.type}×${i.qty}`).join(', ')}</td>
              <td className="text-xs">
                {r.kind === 'extra_only' ? (
                  <div className="flex flex-col gap-1">
                    <span>
                      {r.unit_cost === null ? <Pill tone="warning">Modal belum diisi</Pill> : `${rupiah(r.unit_cost)} / voucher`}
                    </span>
                    <span className="text-ink-500">{r.source_note}{r.received_on ? ` · ${dateLabel(r.received_on)}` : ''}</span>
                    {isOwner && r.unit_cost === null && (
                      <ActionForm action={setRestockCost} className="flex gap-1.5">
                        <input type="hidden" name="restock" value={r.id} />
                        <input name="unit_cost" inputMode="numeric" required placeholder="Rp/voucher" className={`${inputCls} w-28`} />
                        <SubmitButton variant="ghost" className="min-h-11 px-3">Isi</SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                ) : (
                  <span className="text-ink-500">—</span>
                )}
              </td>
              <td className="whitespace-nowrap">{jktDateTime(r.created_at)}</td>
              <td>{profiles?.find((p) => p.id === r.created_by)?.full_name ?? '—'}</td>
              <td><Pill tone="success">{(vouchers ?? []).filter((v) => v.restock_id === r.id).length} voucher masuk</Pill></td>
            </tr>
          ))}
        </Table>
        </div>
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
            <li key={g} className="flex gap-2"><span className="icon-tile size-5 shrink-0 rounded-full bg-mint-100 text-mint-500"><Icon name="check" className="size-3.5" /></span>{g}</li>
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
