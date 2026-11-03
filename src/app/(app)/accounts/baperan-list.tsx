import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { CopyButton } from '@/components/copy-button'
import { Pill, Table, inputCls, labelCls } from '@/components/ui'
import { loadBaperan, type BaperanFilter } from '@/lib/accounts'
import { BAPERAN_SOON_DAYS, BAPERAN_STATUS, daysLeftLabel, phoneLabel, type BaperanStatus } from '@/lib/baperan'
import { dateLabel, rupiah } from '@/lib/format'
import { VOUCHER_STATUS } from '@/lib/inventory'
import { updateBaperan } from './actions'

const FILTERS: { key: '' | BaperanStatus; label: string }[] = [
  { key: '', label: 'Semua' },
  { key: 'aktif', label: BAPERAN_STATUS.aktif.label },
  { key: 'segera', label: BAPERAN_STATUS.segera.label },
  { key: 'kedaluwarsa', label: BAPERAN_STATUS.kedaluwarsa.label },
]

/** Inventaris Baperan: nomor (bisa disalin), PIN khusus owner, tanggal restock, masa aktif, status. Tidak ada penghapusan otomatis. */
export async function BaperanList({ supabase, isOwner, f }: { supabase: SupabaseClient; isOwner: boolean; f: BaperanFilter }) {
  const { rows, filtered, today } = await loadBaperan(supabase, f)
  const count = (k: '' | BaperanStatus) => (k ? rows.filter((r) => r.status === k).length : rows.length)
  const href = (k: string) => {
    const p = new URLSearchParams({ view: 'baperan', ...(k ? { bstatus: k } : {}), ...(f.q ? { q: f.q } : {}) })
    return `/accounts?${p}`
  }

  const editForm = (r: (typeof rows)[number]) => (
    <details className="text-sm">
      <summary className="cursor-pointer whitespace-nowrap text-xs font-semibold text-orange-700">Ubah</summary>
      <ActionForm action={updateBaperan} className="mt-2 flex min-w-[220px] flex-col gap-2" confirm={`Simpan perubahan akun ${r.account_code}?`}>
        <input type="hidden" name="account" value={r.id} />
        <label className={labelCls}>Aktif sampai<input type="date" name="active_until" required defaultValue={r.active_until} min={r.restock?.received_on ?? undefined} className={inputCls} /></label>
        <label className={labelCls}>PIN (kosong = tanpa PIN)<input name="pin" inputMode="numeric" maxLength={8} pattern="\d{4,8}" defaultValue={r.pin ?? ''} autoComplete="off" className={inputCls} /></label>
        <label className={labelCls}>Alasan<input name="reason" required minLength={3} placeholder="mis. diperpanjang reseller" autoComplete="off" className={inputCls} /></label>
        <SubmitButton variant="ghost">Simpan</SubmitButton>
      </ActionForm>
    </details>
  )

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Filter masa aktif" className="flex flex-wrap gap-2">
        {FILTERS.map((x) => {
          const active = (f.bstatus ?? '') === x.key
          return (
            <Link
              key={x.key || 'all'}
              href={href(x.key)}
              aria-current={active ? 'page' : undefined}
              className={`btn-press flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors ${active ? 'border-navy-900 bg-navy-900 text-white' : 'border-[#dcd2bf] bg-white hover:bg-cream-100'}`}
            >
              {x.label}
              <span className={`rounded-full px-1.5 text-xs ${active ? 'bg-navy-700' : 'bg-cream-100 text-ink-500'}`}>{count(x.key)}</span>
            </Link>
          )
        })}
      </nav>

      <form className="flex flex-wrap items-end gap-2 rounded-2xl border border-cream-300 bg-white p-4" role="search">
        <input type="hidden" name="view" value="baperan" />
        {f.bstatus && <input type="hidden" name="bstatus" value={f.bstatus} />}
        <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm font-semibold">
          Cari akun Baperan
          <input name="q" defaultValue={f.q} placeholder="Nomor telepon, ID akun, atau ID voucher" className={inputCls} />
        </label>
        <button className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Cari</button>
        <Link href="/accounts?view=baperan" className="flex min-h-11 items-center px-2 text-sm font-semibold text-orange-700">Hapus filter</Link>
      </form>

      {/* HP & tablet: kartu per akun (tabel lebar baru dipakai di desktop). */}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:hidden">
        {filtered.map((r) => {
          const st = BAPERAN_STATUS[r.status]
          return (
            <li key={r.id} className="card-hover flex flex-col gap-2 rounded-xl border border-cream-300 bg-white p-3.5">
              <span className="flex items-center justify-between gap-2">
                <Link href={`/accounts/${r.id}`} className="font-mono font-semibold">{r.account_code}</Link>
                <Pill tone={st.tone}>{st.label}</Pill>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{phoneLabel(r.account_number)}</span>
                <CopyButton value={r.account_number} />
              </span>
              {isOwner && r.pin && (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  PIN <span className="font-mono">{r.pin}</span> <CopyButton value={r.pin} />
                </span>
              )}
              <span className="text-xs text-ink-500">
                Restock {r.restock?.received_on ? dateLabel(r.restock.received_on) : '—'} · aktif s/d <b className="text-navy-900">{dateLabel(r.active_until, 'long')}</b> ({daysLeftLabel(r.active_until, today)})
              </span>
              <span className="text-xs text-ink-500">Voucher {r.voucher ? `${r.voucher.code} · ${VOUCHER_STATUS[r.voucher.status].label}` : '—'}</span>
              {isOwner && (
                <span className="text-xs text-ink-500">
                  Modal {r.voucher?.allocated_cost === null || r.voucher?.allocated_cost === undefined ? <span className="text-warning-700">belum diisi</span> : rupiah(r.voucher.allocated_cost)}
                </span>
              )}
              {isOwner && editForm(r)}
            </li>
          )
        })}
        {!filtered.length && <li className="rounded-xl bg-white p-4 text-sm text-ink-500">Tidak ada akun Baperan yang cocok.</li>}
      </ul>

      <section className="hidden rounded-2xl border border-cream-300 bg-white p-4 sm:p-5 lg:block">
        <Table
          head={['Akun', 'Nomor telepon', ...(isOwner ? ['PIN'] : []), isOwner ? 'Restock · modal' : 'Restock', 'Aktif sampai', 'Status · ID voucher']}
          empty="Tidak ada akun Baperan yang cocok."
        >
          {filtered.map((r) => {
            const st = BAPERAN_STATUS[r.status]
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  <span className="flex flex-col items-start gap-0.5">
                    <Link href={`/accounts/${r.id}`} className="font-mono text-[13px] font-semibold">{r.account_code}</Link>
                    {isOwner && editForm(r)}
                  </span>
                </td>
                <td>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span className="font-mono text-[13px]">{phoneLabel(r.account_number)}</span>
                    <CopyButton value={r.account_number} />
                  </span>
                </td>
                {isOwner && (
                  <td>
                    {r.pin ? (
                      <span className="flex items-center gap-2 whitespace-nowrap"><span className="font-mono text-[13px]">{r.pin}</span><CopyButton value={r.pin} /></span>
                    ) : <span className="text-ink-500">—</span>}
                  </td>
                )}
                <td className="whitespace-nowrap">
                  <span className="flex flex-col">
                    <span>{r.restock?.received_on ? dateLabel(r.restock.received_on).replace(/^\S+, /, '') : '—'}</span>
                    {isOwner && (
                      <span className="text-xs text-ink-500">
                        {r.voucher?.allocated_cost === null || r.voucher?.allocated_cost === undefined ? <span className="text-warning-700">Modal belum diisi</span> : rupiah(r.voucher.allocated_cost)}
                      </span>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap">
                  <span className="flex flex-col">
                    <span className="font-semibold">{dateLabel(r.active_until, 'long')}</span>
                    <span className="text-xs text-ink-500">{daysLeftLabel(r.active_until, today)}</span>
                  </span>
                </td>
                <td className="whitespace-nowrap">
                  <span className="flex flex-col items-start gap-1">
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {r.voucher && <span className="text-xs text-ink-500"><span className="font-mono">{r.voucher.code}</span> · {VOUCHER_STATUS[r.voucher.status].label}</span>}
                  </span>
                </td>
              </tr>
            )
          })}
        </Table>
      </section>
      <p className="text-xs text-ink-500">
        Menampilkan {filtered.length} dari {rows.length} akun Baperan. Satu nomor telepon = satu akun = 1 voucher Baperan. &quot;Segera Kedaluwarsa&quot; = sisa
        masa aktif {BAPERAN_SOON_DAYS} hari atau kurang. Akun kedaluwarsa tidak bisa dipakai untuk transaksi baru, tetapi tidak dihapus otomatis.
        {!isOwner && ' PIN hanya terlihat oleh owner.'}
      </p>
    </div>
  )
}
