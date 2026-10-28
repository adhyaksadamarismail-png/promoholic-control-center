import Link from 'next/link'
import { createSessionClient } from '@/lib/supabase/server'
import { PageHeader, Pill, Table, inputCls } from '@/components/ui'
import { dateLabel, jktDate } from '@/lib/format'
import { ACCOUNT_STATE, VOUCHER_STATUS } from '@/lib/inventory'
import { loadAccounts, type AccountFilter } from '@/lib/accounts'

export const dynamic = 'force-dynamic'

const CHIP: Record<string, string> = {
  available: 'bg-success-100 text-success-700 border-success-700/30',
  used: 'bg-[#eef0f4] text-[#6e7689] border-transparent line-through',
  reserved: 'bg-warning-100 text-warning-700 border-warning-700/30',
  expired: 'bg-danger-100 text-danger-700 border-danger-700/30',
  broken: 'bg-danger-100 text-danger-700 border-danger-700/30',
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<AccountFilter> }) {
  const f = await searchParams
  const supabase = await createSessionClient()
  const { data: role } = await supabase.rpc('current_app_role')
  const { brands, types, rows, filtered, incomplete } = await loadAccounts(supabase, f)
  const typeCode = (id: string) => types.find((t) => t.id === id)?.code ?? '?'
  const exportQs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow={role === 'owner' ? 'Akses penuh · VM & Panel Admin' : 'Nomor akun disamarkan untuk staf'} title="Daftar Akun">
        <a href={`/accounts/export${exportQs ? '?' + exportQs : ''}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">
          Export CSV
        </a>
      </PageHeader>

      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0 md:pb-0">
        {brands.map((b) => {
          const vs = rows.filter((r) => r.brand_id === b.id).flatMap((r) => r.vouchers)
          const main = vs.filter((v) => v.grp === 'main' && v.status === 'available').length
          const extra = vs.filter((v) => v.grp === 'extra' && v.status === 'available').length
          return (
            <Link
              key={b.id}
              href={`/accounts?brand=${b.id}`}
              className={`flex min-w-[150px] shrink-0 flex-col gap-1 rounded-xl border bg-white p-3.5 md:min-w-0 ${f.brand === b.id ? 'border-orange-500' : 'border-cream-300'}`}
            >
              <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">{b.name}</span>
              <span className="font-display text-2xl font-bold">{main + extra}</span>
              <span className="text-xs text-ink-500">voucher tersedia{extra ? ` · ${main} utama, ${extra} tambahan` : ''}</span>
              {incomplete.has(b.id) && <span className="text-xs font-semibold text-warning-700">Ketentuan belum lengkap</span>}
            </Link>
          )
        })}
      </div>

      <form className="flex flex-wrap items-end gap-2 rounded-2xl border border-cream-300 bg-white p-4" role="search">
        <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm font-semibold">
          Cari akun
          <input name="q" defaultValue={f.q} placeholder="ID akun, nomor, atau ID voucher" className={inputCls} />
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
        <Link href="/accounts" className="flex min-h-11 items-center px-2 text-sm font-semibold text-orange-700">Hapus filter</Link>
      </form>

      <div className="flex flex-wrap gap-3 text-xs text-ink-500">
        {(['available', 'used', 'reserved', 'broken'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`rounded border px-1.5 font-bold ${CHIP[s]}`}>A</span> {VOUCHER_STATUS[s].label}
          </span>
        ))}
      </div>

      {/* HP: daftar kartu agar ID akun, voucher, dan status terlihat tanpa menggeser tabel. */}
      <ul className="flex flex-col gap-2 md:hidden">
        {filtered.map((r) => {
          const main = r.vouchers.filter((v) => v.grp === 'main')
          const extra = r.vouchers.filter((v) => v.grp === 'extra')
          const st = ACCOUNT_STATE[r.state]
          const expired = r.active_until && r.active_until < jktDate()
          return (
            <li key={r.id}>
              <Link href={`/accounts/${r.id}`} className="flex flex-col gap-2 rounded-xl border border-cream-300 bg-white p-3.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold">{r.account_code}</span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </span>
                <span className="text-xs text-ink-500">
                  {brands.find((b) => b.id === r.brand_id)?.name} · {r.source === 'vm' ? `VM${r.vm_device_id ? ' ' + r.vm_device_id : ''}` : 'Panel'}
                  {r.account_number && <span className="font-mono"> · {r.account_number}</span>}
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {main.map((v) => (
                    <span key={v.id} className={`rounded border px-1.5 text-xs font-bold ${CHIP[v.status]}`}>{typeCode(v.voucher_type_id)}</span>
                  ))}
                  {extra.length > 0 && <span className="text-xs text-ink-500">· tambahan {extra.filter((v) => v.status === 'available').length}/{extra.length}</span>}
                  {r.active_until && (
                    <span className={`ml-auto text-xs ${expired ? 'font-semibold text-danger-700' : 'text-ink-500'}`}>s/d {dateLabel(r.active_until)}</span>
                  )}
                </span>
              </Link>
            </li>
          )
        })}
        {!filtered.length && <li className="rounded-xl bg-white p-4 text-sm text-ink-500">Tidak ada akun yang cocok.</li>}
      </ul>

      <section className="hidden rounded-2xl border border-cream-300 bg-white p-4 sm:p-5 md:block">
        <Table head={['ID akun', 'Brand', 'Sumber', 'Nomor akun', 'Masuk', 'Aktif s/d', 'Voucher utama', 'Tambahan', 'Status', '']} empty="Tidak ada akun yang cocok.">
          {filtered.map((r) => {
            const main = r.vouchers.filter((v) => v.grp === 'main')
            const extra = r.vouchers.filter((v) => v.grp === 'extra')
            const st = ACCOUNT_STATE[r.state]
            const expired = r.active_until && r.active_until < jktDate()
            return (
              <tr key={r.id}>
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
                <td><Pill tone={st.tone}>{st.label}</Pill></td>
                <td><Link href={`/accounts/${r.id}`} className="font-semibold text-orange-700">Detail</Link></td>
              </tr>
            )
          })}
        </Table>
      </section>
      <p className="text-xs text-ink-500">
          Menampilkan {filtered.length} dari {rows.length} akun. Nomor akun hanya ada untuk akun dari Virtual Machine. Stok dihitung dari data yang dicatat di
          aplikasi ini, bukan disinkronkan dari aplikasi brand.
      </p>
    </div>
  )
}
