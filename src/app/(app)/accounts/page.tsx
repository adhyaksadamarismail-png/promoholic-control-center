import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/auth'
import { Note, PageHeader, Pill, Table, Tabs, inputCls } from '@/components/ui'
import { dateLabel, jktDate } from '@/lib/format'
import { ACCOUNT_STATE, VOUCHER_STATUS, stockLevel } from '@/lib/inventory'
import { loadAccounts, type AccountFilter } from '@/lib/accounts'
import { BulkAccountProvider, RowCheck } from './bulk-archive'
import { AccountSearch } from './account-search'
import { BaperanList } from './baperan-list'

export const dynamic = 'force-dynamic'

const CHIP: Record<string, string> = {
  available: 'bg-success-100 text-success-700 border-success-700/30',
  used: 'bg-[#eef0f4] text-[#6e7689] border-transparent line-through',
  reserved: 'bg-warning-100 text-warning-700 border-warning-700/30',
  expired: 'bg-danger-100 text-danger-700 border-danger-700/30',
  broken: 'bg-danger-100 text-danger-700 border-danger-700/30',
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<AccountFilter & { archived?: string; view?: string; bstatus?: string; tampil?: string }> }) {
  const { archived, view, bstatus, tampil, ...f } = await searchParams
  const asTable = tampil === 'tabel' // layar lebar: kartu (bawaan) atau tabel padat
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase } = viewer
  const role = viewer.profile.role
  const tabs = (
    <Tabs
      items={[
        { key: 'regular', label: 'Akun reguler', href: '/accounts' },
        { key: 'baperan', label: 'Inventaris Baperan', href: '/accounts?view=baperan' },
        ...(role === 'owner' ? [{ key: 'arsip', label: 'Diarsipkan', href: '/accounts?view=arsip' }] : []),
      ]}
      active={view === 'baperan' || (view === 'arsip' && role === 'owner') ? view : 'regular'}
    />
  )
  if (view === 'baperan')
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <PageHeader eyebrow="Inventaris terpisah · 1 identitas = 1 akun = 1 voucher" title="Daftar Akun">
          {(role === 'owner' || viewer.profile.can_restock_panel) && (
            <Link href="/panel?mode=extra" className="flex min-h-11 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Restock Baperan</Link>
          )}
        </PageHeader>
        {tabs}
        <BaperanList supabase={supabase} isOwner={role === 'owner'} f={{ q: f.q, bstatus: ['aktif', 'segera', 'kedaluwarsa'].includes(bstatus ?? '') ? bstatus : undefined }} />
      </div>
    )
  const inArchive = view === 'arsip' && role === 'owner'
  const { brands, types, rows, filtered, incomplete } = await loadAccounts(supabase, f, inArchive)
  const typeCode = (id: string) => types.find((t) => t.id === id)?.code ?? '?'
  const isOwner = role === 'owner'
  // Owner: daftar dibungkus pilihan arsip/pulihkan massal (checkbox per baris). Staf: daftar biasa.
  const Selectable = ({ children }: { children: React.ReactNode }) =>
    isOwner ? <BulkAccountProvider key={inArchive ? 'restore' : 'archive'} mode={inArchive ? 'restore' : 'archive'} rows={filtered.map((r) => ({ id: r.id, code: r.account_code }))}>{children}</BulkAccountProvider> : <>{children}</>
  // Kunci berganti saat filter berubah agar daftar masuk dengan transisi halus.
  const listKey = JSON.stringify([view, f.q, f.brand, f.source, f.status])
  const emptyText = !rows.length && inArchive ? 'Belum ada akun diarsipkan.' : f.q ? `Tidak ada akun dengan ID "${f.q}".` : 'Tidak ada akun yang cocok dengan filter ini.'
  const exportQs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow={inArchive ? 'Khusus owner · akun nonaktif, histori tetap utuh' : role === 'owner' ? 'Akses penuh · VM & Panel Admin' : 'Nomor akun disamarkan untuk staf'} title="Daftar Akun">
        {!inArchive && (
          <a href={`/accounts/export${exportQs ? '?' + exportQs : ''}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">
            Export CSV
          </a>
        )}
      </PageHeader>
      {tabs}
      {archived && <Note>Akun {archived} diarsipkan. Transaksi dan voucher tidak berubah; pulihkan kapan saja dari tab Diarsipkan.</Note>}

      {!inArchive && <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0 md:pb-0">
        {brands.map((b) => {
          const vs = rows.filter((r) => r.brand_id === b.id).flatMap((r) => r.vouchers)
          const main = vs.filter((v) => v.grp === 'main' && v.status === 'available').length
          const extra = vs.filter((v) => v.grp === 'extra' && v.status === 'available').length
          return (
            <Link
              key={b.id}
              href={`/accounts?brand=${b.id}`}
              className={`card-hover flex min-w-[150px] shrink-0 flex-col gap-1 rounded-xl border bg-white p-3.5 md:min-w-0 ${f.brand === b.id ? 'border-orange-500' : 'border-cream-300'}`}
            >
              <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">{b.name}</span>
              <span className="font-display text-2xl font-bold">{main + extra}</span>
              <span className="text-xs text-ink-500">voucher tersedia{extra ? ` · ${main} utama, ${extra} tambahan` : ''}</span>
              {incomplete.has(b.id) && <span className="text-xs font-semibold text-warning-700">Ketentuan belum lengkap</span>}
            </Link>
          )
        })}
      </div>}

      <form className="flex flex-wrap items-end gap-2 rounded-2xl border border-cream-300 bg-white p-4" role="search">
        {inArchive && <input type="hidden" name="view" value="arsip" />}
        <label className="flex w-full flex-col gap-1.5 text-sm font-semibold">
          Cari ID akun
          <AccountSearch />
        </label>
        <label className="flex min-w-[100px] flex-1 flex-col gap-1.5 text-sm font-semibold sm:flex-none">
          Brand
          <select name="brand" defaultValue={f.brand ?? ''} className={inputCls}>
            <option value="">Semua brand</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="flex min-w-[100px] flex-1 flex-col gap-1.5 text-sm font-semibold sm:flex-none">
          Sumber
          <select name="source" defaultValue={f.source ?? ''} className={inputCls}>
            <option value="">Semua sumber</option>
            <option value="vm">Virtual Machine</option>
            <option value="panel">Panel Admin</option>
          </select>
        </label>
        <label className="flex min-w-[100px] flex-1 flex-col gap-1.5 text-sm font-semibold sm:flex-none">
          Status
          <select name="status" defaultValue={f.status ?? ''} className={inputCls}>
            <option value="">Semua status</option>
            {Object.entries(ACCOUNT_STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <button className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Terapkan</button>
        <Link href={inArchive ? '/accounts?view=arsip' : '/accounts'} className="flex min-h-11 items-center px-2 text-sm font-semibold text-orange-700">Hapus filter</Link>
      </form>

      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-500">
        {(['available', 'used', 'reserved', 'broken'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`rounded border px-1.5 font-bold ${CHIP[s]}`}>A</span> {VOUCHER_STATUS[s].label}
          </span>
        ))}
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#f5b544]" /> MENIPIS = sisa ≤2 voucher</span>
        <nav aria-label="Tampilan daftar" className="ml-auto hidden rounded-xl bg-white p-1 ring-1 ring-cream-300 md:flex">
          {[{ k: 'kartu', l: 'Kartu' }, { k: 'tabel', l: 'Tabel' }].map((t) => {
            const qs = new URLSearchParams(Object.entries({ ...f, view, tampil: t.k === 'tabel' ? 'tabel' : undefined }).filter(([, v]) => v) as [string, string][]).toString()
            const on = (t.k === 'tabel') === asTable
            return (
              <Link key={t.k} href={`/accounts${qs ? '?' + qs : ''}`} scroll={false} aria-current={on ? 'page' : undefined} className={`btn-press flex min-h-8 items-center rounded-lg px-3 font-semibold ${on ? 'bg-navy-900 text-white' : 'text-ink-500 hover:text-navy-900'}`}>
                {t.l}
              </Link>
            )
          })}
        </nav>
      </div>

      <Selectable>
      {/* HP: daftar kartu agar ID akun, voucher, dan status terlihat tanpa menggeser tabel. */}
      <ul key={`m-${listKey}`} className={`account-list grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${asTable ? 'md:hidden' : ''}`}>
        {filtered.map((r) => {
          const main = r.vouchers.filter((v) => v.grp === 'main')
          const extra = r.vouchers.filter((v) => v.grp === 'extra')
          const st = ACCOUNT_STATE[r.state]
          const expired = r.active_until && r.active_until < jktDate()
          const avail = r.vouchers.filter((v) => v.status === 'available').length
          const level = stockLevel(avail)
          return (
            <li key={r.id} data-reveal className="relative">
              <Link
                href={`/accounts/${r.id}`}
                className={`card-hover flex h-full min-w-0 flex-col gap-2.5 rounded-2xl border border-cream-300 bg-white p-4 ${isOwner ? 'pl-12' : ''}`}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono text-base font-bold [overflow-wrap:anywhere]">{r.account_code}</span>
                    <span className="text-xs text-ink-500">
                      {brands.find((b) => b.id === r.brand_id)?.name} · {r.source === 'vm' ? `VM${r.vm_device_id ? ' ' + r.vm_device_id : ''}` : 'Panel'}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    title={level === 'menipis' ? 'Stok menipis' : 'Stok cukup'}
                    className={`mt-1.5 size-2.5 shrink-0 rounded-full ${avail === 0 ? 'bg-[#c9cdd6]' : level === 'menipis' ? 'bg-[#f5b544]' : 'bg-[#4fb286]'}`}
                  />
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-display text-xl font-bold">{avail}</span>
                  <span className="text-xs text-ink-500">voucher tersedia</span>
                  {avail > 0 && level === 'menipis' && <span className="ml-auto rounded-full bg-warning-100 px-2 py-0.5 text-[10px] font-bold text-warning-700">MENIPIS</span>}
                </span>
                {r.account_number && <span className="font-mono text-xs text-ink-500">{r.account_number}</span>}
                {inArchive && r.archived_at && <span className="text-xs text-ink-500">Diarsipkan {dateLabel(jktDate(r.archived_at))}{r.archive_note ? ` · ${r.archive_note}` : ''}</span>}
                <span className="mt-auto flex flex-wrap items-center gap-1 border-t border-[#f3ede2] pt-2.5">
                  {main.map((v) => (
                    <span key={v.id} title={`${v.code} · ${VOUCHER_STATUS[v.status].label}`} className={`rounded-md border px-1.5 text-xs font-bold ${CHIP[v.status]}`}>{typeCode(v.voucher_type_id)}</span>
                  ))}
                  {extra.length > 0 && <span className="text-xs text-ink-500">· tambahan {extra.filter((v) => v.status === 'available').length}/{extra.length}</span>}
                  <span className="ml-auto"><Pill tone={st.tone}>{st.label}</Pill></span>
                </span>
                {r.active_until && (
                  <span className={`text-xs ${expired ? 'font-semibold text-danger-700' : 'text-ink-500'}`}>Aktif s/d {dateLabel(r.active_until)}</span>
                )}
              </Link>
              {isOwner && (
                <span className="absolute left-3 top-4">
                  <RowCheck id={r.id} code={r.account_code} />
                </span>
              )}
            </li>
          )
        })}
        {!filtered.length && <li className="col-span-full rounded-2xl border border-dashed border-cream-300 bg-white/70 p-8 text-center text-sm text-ink-500">{emptyText}</li>}
      </ul>

      <section key={`d-${listKey}`} className={`account-list animate-enter hidden rounded-2xl border border-cream-300 bg-white p-4 sm:p-5 ${asTable ? 'md:block' : ''}`}>
        <Table head={[...(isOwner ? ['Pilih'] : []), 'ID akun', 'Brand', 'Sumber', 'Nomor akun', 'Masuk', 'Aktif s/d', 'Voucher utama', 'Tambahan', 'Status', '']} empty={emptyText}>
          {filtered.map((r) => {
            const main = r.vouchers.filter((v) => v.grp === 'main')
            const extra = r.vouchers.filter((v) => v.grp === 'extra')
            const st = ACCOUNT_STATE[r.state]
            const expired = r.active_until && r.active_until < jktDate()
            return (
              <tr key={r.id}>
                {isOwner && <td><RowCheck id={r.id} code={r.account_code} /></td>}
                <td className="whitespace-nowrap font-mono text-[13px] font-semibold">
                  <Link href={`/accounts/${r.id}`}>{r.account_code}</Link>
                </td>
                <td>{brands.find((b) => b.id === r.brand_id)?.name}</td>
                <td>{r.source === 'vm' ? `VM${r.vm_device_id ? ' · ' + r.vm_device_id : ''}` : 'Panel'}</td>
                <td className="whitespace-nowrap font-mono text-[13px]">{r.account_number ?? '—'}</td>
                <td className="whitespace-nowrap">{dateLabel(jktDate(r.entered_at))}</td>
                <td className={`whitespace-nowrap ${expired ? 'font-semibold text-danger-700' : ''}`}>{r.active_until ? dateLabel(r.active_until) : '—'}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {main.map((v) => (
                      <span key={v.id} title={`${v.code} · ${VOUCHER_STATUS[v.status].label}`} className={`rounded border px-1.5 text-xs font-bold ${CHIP[v.status]}`}>
                        {typeCode(v.voucher_type_id)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap">{extra.length ? `${extra.filter((v) => v.status === 'available').length}/${extra.length}` : '—'}</td>
                <td>
                  <Pill tone={st.tone}>{st.label}</Pill>
                  {inArchive && r.archived_at && <div className="mt-1 whitespace-nowrap text-xs text-ink-500">Diarsipkan {dateLabel(jktDate(r.archived_at))}</div>}
                  {inArchive && r.archive_note && <div className="text-xs text-ink-500">{r.archive_note}</div>}
                </td>
                <td><Link href={`/accounts/${r.id}`} className="font-semibold text-orange-700">Detail</Link></td>
              </tr>
            )
          })}
        </Table>
      </section>
      </Selectable>
      <p className="text-xs text-ink-500">
          Menampilkan {filtered.length} dari {rows.length} akun{inArchive ? ' di arsip' : ''}. Nomor akun hanya ada untuk akun dari Virtual Machine. Stok dihitung dari data yang dicatat di
          aplikasi ini, bukan disinkronkan dari aplikasi brand.
      </p>
    </div>
  )
}
