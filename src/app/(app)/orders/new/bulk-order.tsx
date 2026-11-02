'use client'

import { useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useHydrated } from '@/components/action-form'
import { BULK_ORDER_TEMPLATE, parseBulkOrders, type BulkOrderInput } from '@/lib/bulk-order'
import { commitBulkOrders, previewBulkOrders, type BulkOrderChecked, type BulkOrderSaved } from './bulk-actions'

type Brand = { id: string; name: string }
type Account = { id: string; brand_id: string; account_code: string }
type VType = { id: string; brand_id: string; code: string; name: string; sort_order: number }

const rp = (n: number | null | undefined) => (n === null || n === undefined ? '—' : (n < 0 ? '−Rp' : 'Rp') + Math.abs(Math.round(n)).toLocaleString('id-ID'))
const digits = (v: string) => { const d = v.replace(/[^\d]/g, ''); return d ? Number(d) : null }
const input = 'min-h-11 w-full min-w-0 rounded-lg border border-[#dcd2bf] bg-white px-3 text-base outline-orange-500'
const label = 'flex min-w-0 flex-col gap-1 text-xs font-semibold text-ink-500'
const ghost = 'btn-press flex min-h-11 items-center justify-center rounded-lg border border-[#dcd2bf] bg-white px-3.5 text-sm font-semibold disabled:opacity-50'

const blank = (brand = ''): BulkOrderInput => ({ key: crypto.randomUUID(), brand, account: '', voucher: '', name: '', wa: '', menu: null, sell: null, extra: 0, manual: null, override: null, ref: '' })

/** Bulk Transaksi: banyak baris → validasi server → simpan yang valid lewat record_order, per baris. */
export function BulkOrder({ brands, accounts, types }: { brands: Brand[]; accounts: Account[]; types: VType[] }) {
  const hydrated = useHydrated()
  const [rows, setRows] = useState<BulkOrderInput[]>(() => [])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [checked, setChecked] = useState<Map<string, BulkOrderChecked> | null>(null)
  const [saved, setSaved] = useState<(BulkOrderSaved & { label: string })[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const sending = useRef(false) // cegah klik ganda sebelum state 'busy' aktif
  const fileRef = useRef<HTMLInputElement>(null)

  const list = hydrated && !rows.length ? [] : rows
  const results = checked ? list.flatMap((r) => { const c = checked.get(r.key); return c ? [{ r, c }] : [] }) : []
  const valid = results.filter((x) => x.c.ok)
  const totals = {
    omzet: valid.reduce((a, x) => a + (x.r.sell ?? 0), 0),
    laba: valid.reduce((a, x) => a + (x.c.net ?? 0), 0),
  }

  const edit = (key: string, patch: Partial<BulkOrderInput>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setChecked(null)
  }
  const add = (items: BulkOrderInput[]) => { setRows((rs) => [...rs, ...items]); setChecked(null); setSaved(null) }
  const remove = (keys: string[]) => {
    setLeaving(new Set(keys))
    setTimeout(() => {
      setRows((rs) => rs.filter((r) => !keys.includes(r.key)))
      setPicked(new Set())
      setLeaving(new Set())
      setChecked(null)
    }, 160)
  }
  const duplicate = (keys: string[]) => add(rows.filter((r) => keys.includes(r.key)).map((r) => ({ ...r, key: crypto.randomUUID() })))
  const brandId = (v: string) => brands.find((b) => b.id.toLowerCase() === v.trim().toLowerCase() || b.name.toLowerCase() === v.trim().toLowerCase())?.id ?? v
  const parsed = (text: string) => parseBulkOrders(text, () => crypto.randomUUID()).map((r) => ({ ...r, brand: brandId(r.brand) }))

  function onPaste(e: React.ClipboardEvent, key: string) {
    const text = e.clipboardData.getData('text')
    if (!/[\t\n]/.test(text.trim())) return // tempel satu nilai: biarkan normal
    e.preventDefault()
    const items = parsed(text)
    const row = rows.find((r) => r.key === key)
    const empty = row && !row.account && !row.name && !row.menu
    setRows((rs) => [...(empty ? rs.filter((r) => r.key !== key) : rs), ...items])
    setChecked(null)
  }
  async function upload(f: File | undefined) {
    if (!f) return
    if (f.size > 1024 * 1024) return setMessage('File CSV maksimal 1 MB.')
    const items = parsed(await f.text())
    if (!items.length) return setMessage('File CSV kosong.')
    setMessage(null)
    add(items)
    if (fileRef.current) fileRef.current.value = ''
  }
  function template() {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([BULK_ORDER_TEMPLATE], { type: 'text/csv' }))
    a.download = 'template-bulk-transaksi.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  function validate() {
    setMessage(null)
    setSaved(null)
    start(async () => {
      const r = await previewBulkOrders(rows)
      if (!r.ok) return setMessage(r.message)
      setChecked(new Map((r.data as BulkOrderChecked[]).map((c) => [c.key, c])))
    })
  }
  function save() {
    if (!valid.length || sending.current) return
    sending.current = true
    const batch = valid
    start(async () => {
      const r = await commitBulkOrders(batch.map(({ r, c }) => ({
        key: r.key, voucherId: c.voucherId as string, name: r.name.trim(), wa: r.wa, ref: r.ref.trim(),
        menu: r.menu as number, sell: r.sell as number, extra: r.extra, manual: r.manual, override: r.override,
      })))
      sending.current = false
      if (!r.ok) return setMessage(r.message)
      const out = r.data as BulkOrderSaved[]
      const labelOf = (key: string) => { const x = batch.find((b) => b.r.key === key); return `${x?.c.accountCode ?? ''} · ${x?.c.voucherCode ?? ''}` }
      setSaved(out.map((s) => ({ ...s, label: labelOf(s.key) })))
      // Baris tersimpan keluar dari daftar; baris gagal tetap ada untuk diperbaiki.
      const done = out.filter((s) => s.ok).map((s) => s.key)
      setRows((rs) => rs.filter((x) => !done.includes(x.key)))
      setChecked(null)
    })
  }

  const savedOk = saved?.filter((s) => s.ok) ?? []
  const summary = (
    <div className="flex flex-col gap-1.5 text-sm">
      {[
        ['Total baris', String(list.length)],
        ['Valid', checked ? String(valid.length) : '—'],
        ['Perlu diperbaiki', checked ? String(results.length - valid.length) : '—'],
      ].map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">{k}</span><b>{v}</b></div>
      ))}
      <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Total omzet</span><b>{checked ? rp(totals.omzet) : '—'}</b></div>
      <div className="flex justify-between gap-3 py-1.5"><span className="font-semibold">Total laba bersih</span><b className="font-display text-lg text-orange-500">{checked ? rp(totals.laba) : '—'}</b></div>
      <p className="text-xs text-[#8790a6]">Pratinjau baris valid. Server menghitung ulang dan menyimpan snapshot tiap transaksi.</p>
    </div>
  )
  const primary = checked ? (
    <button type="button" onClick={save} disabled={busy || !valid.length} className="btn-press min-h-12 w-full rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
      {busy ? 'Menyimpan…' : `Simpan ${valid.length} Transaksi`}
    </button>
  ) : (
    <button type="button" onClick={validate} disabled={busy || !list.length} className="btn-press min-h-12 w-full rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
      {busy ? 'Memvalidasi…' : 'Validasi & Preview'}
    </button>
  )

  return (
    <div className="grid grid-cols-1 items-start gap-4 pb-28 lg:grid-cols-[minmax(0,1fr)_320px] lg:pb-0">
      <div className="flex min-w-0 flex-col gap-4">
        {saved && (
          <section role="status" className="animate-enter flex flex-col gap-2 rounded-2xl border border-success-700 bg-success-100 p-4 sm:p-5">
            <h2 className="font-display text-lg font-semibold text-success-700">{savedOk.length} dari {saved.length} transaksi tersimpan</h2>
            <p className="text-sm text-success-700">
              Gagal {saved.length - savedOk.length} · Omzet {rp(savedOk.reduce((a, s) => a + (s.sell ?? 0), 0))} · Laba bersih {rp(savedOk.reduce((a, s) => a + (s.net ?? 0), 0))}
            </p>
            <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto text-xs">
              {saved.map((s) => (
                <li key={s.key} className={s.ok ? 'text-success-700' : 'text-danger-700'}>
                  <span className="font-mono">{s.label}</span> — {s.ok ? `${s.code}, laba ${rp(s.net)}` : `gagal: ${s.error}`}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-display text-base font-semibold">Input transaksi ({list.length})</h2>
            <button type="button" onClick={template} className={ghost}>Unduh Template CSV</button>
            <input ref={fileRef} id="bulk-order-csv" type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
            <label htmlFor="bulk-order-csv" className={`${ghost} cursor-pointer`}>Upload CSV</label>
          </div>
          <p className="text-xs text-ink-500">Bisa juga tempel beberapa baris dari spreadsheet ke kolom mana pun (urutan kolom sama dengan template).</p>

          <div className="flex flex-col gap-2.5">
            {list.map((r, i) => {
              const c = checked?.get(r.key)
              const brandTypes = types.filter((t) => t.brand_id === r.brand).sort((a, b) => a.sort_order - b.sort_order)
              const brandAccounts = accounts.filter((a) => a.brand_id === r.brand)
              const money = (k: 'menu' | 'sell' | 'extra' | 'manual' | 'override', text: string, placeholder?: string) => (
                <label className={label}>
                  {text}
                  <input inputMode="numeric" value={r[k] === null ? '' : r[k].toLocaleString('id-ID')} placeholder={placeholder} onChange={(e) => edit(r.key, { [k]: digits(e.target.value) })} onPaste={(e) => onPaste(e, r.key)} className={input} />
                </label>
              )
              return (
                <article key={r.key} className={`flex flex-col gap-2 rounded-xl border p-3 ${leaving.has(r.key) ? 'animate-row-leave' : 'animate-enter'} ${c && !c.ok ? 'border-danger-700 bg-danger-100/40' : c?.ok ? 'border-success-700/50' : 'border-[#eadfcb]'}`}>
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" aria-label={`Pilih baris ${i + 1}`} checked={picked.has(r.key)} className="size-5"
                      onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n })} />
                    <span className="whitespace-nowrap">Baris {i + 1}</span>
                    {c?.ok && <span className="rounded-full bg-success-100 whitespace-nowrap px-2 py-0.5 text-xs font-bold text-success-700">Valid · laba {rp(c.net)}</span>}
                    {c && !c.ok && <span className="rounded-full bg-danger-100 px-2 py-0.5 text-xs font-bold text-danger-700">Perlu diperbaiki</span>}
                    <button type="button" onClick={() => duplicate([r.key])} className="ml-auto min-h-9 px-2 text-xs font-semibold text-orange-700">Duplikat</button>
                    <button type="button" onClick={() => remove([r.key])} className="min-h-9 px-2 text-xs font-semibold text-danger-700">Hapus</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                    <label className={label}>
                      Brand
                      <select value={r.brand} onChange={(e) => edit(r.key, { brand: e.target.value, voucher: '', account: '' })} className={input}>
                        <option value="">Pilih…</option>
                        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </label>
                    <label className={label}>
                      ID akun
                      <input list={`akun-${r.brand}`} value={r.account} onChange={(e) => edit(r.key, { account: e.target.value })} onPaste={(e) => onPaste(e, r.key)} autoComplete="off" className={`${input} font-mono`} />
                      <datalist id={`akun-${r.brand}`}>{brandAccounts.slice(0, 300).map((a) => <option key={a.id} value={a.account_code} />)}</datalist>
                    </label>
                    <label className={`${label} col-span-2 xl:col-span-1`}>
                      Voucher
                      <select value={r.voucher} onChange={(e) => edit(r.key, { voucher: e.target.value })} className={input}>
                        <option value="">{r.voucher && !brandTypes.some((t) => t.code === r.voucher) ? r.voucher : 'Pilih…'}</option>
                        {brandTypes.map((t) => <option key={t.id} value={t.code}>{t.code} · {t.name}</option>)}
                      </select>
                    </label>
                    <label className={label}>Nama customer<input value={r.name} onChange={(e) => edit(r.key, { name: e.target.value })} onPaste={(e) => onPaste(e, r.key)} autoComplete="off" className={input} /></label>
                    <label className={label}>WhatsApp<input value={r.wa} inputMode="tel" onChange={(e) => edit(r.key, { wa: e.target.value })} onPaste={(e) => onPaste(e, r.key)} autoComplete="off" className={input} /></label>
                    {money('menu', 'Harga asli menu')}
                    {money('sell', 'Harga jual Promo.Holic')}
                    {money('extra', 'Biaya tambahan')}
                    {money('manual', 'Potongan manual', 'Hanya jika diperlukan')}
                  </div>
                  {c && !c.ok && <ul className="list-inside list-disc text-xs font-semibold text-danger-700">{c.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
                  {c?.ok && c.reasons.length > 0 && <p className="text-xs text-warning-700">Akan ditandai untuk ditinjau: {c.reasons.join(' · ')}</p>}
                </article>
              )
            })}
            {!list.length && <p className="rounded-xl bg-cream-100 p-6 text-center text-sm text-ink-500">Belum ada baris. Tambah baris, upload CSV, atau tempel dari spreadsheet.</p>}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => add([blank(rows.at(-1)?.brand ?? brands[0]?.id ?? '')])} className={ghost}>+ Tambah Baris</button>
            <button type="button" disabled={!picked.size} onClick={() => duplicate([...picked])} className={ghost}>Duplikat Terpilih</button>
            <button type="button" disabled={!picked.size} onClick={() => remove([...picked])} className={ghost}>Hapus Terpilih</button>
          </div>
        </section>

        {message && <p role="alert" className="animate-enter rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{message}</p>}

        {checked && (
          <section className="animate-enter flex min-w-0 flex-col gap-2 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
            <h2 className="font-display text-base font-semibold">Preview sebelum disimpan</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.05em] text-ink-500">
                  <tr>{['#', 'Brand', 'ID akun', 'Voucher', 'Potongan', 'Bayar merchant', 'Omzet', 'Modal', 'HPP', 'Laba kotor', 'Biaya', 'Laba bersih', 'Status'].map((h) => <th key={h} className="px-2 py-2 font-bold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {results.map(({ r, c }, i) => (
                    <tr key={r.key} className={`border-t border-[#f1eadc] ${c.ok ? '' : 'bg-danger-100/40'}`}>
                      <td className="px-2 py-2">{i + 1}</td>
                      <td className="px-2 py-2">{c.brandName ?? r.brand}</td>
                      <td className="px-2 py-2 font-mono text-[13px]">{c.accountCode ?? r.account}</td>
                      <td className="px-2 py-2 font-mono text-[13px]">{c.voucherCode ?? r.voucher}</td>
                      <td className="px-2 py-2">{rp(c.discount)}</td>
                      <td className="px-2 py-2">{rp(c.after)}</td>
                      <td className="px-2 py-2">{rp(r.sell)}</td>
                      <td className="px-2 py-2">{c.costUnknown ? 'Belum diisi' : rp(c.cost)}</td>
                      <td className="px-2 py-2">{rp(c.hpp)}</td>
                      <td className="px-2 py-2">{rp(c.gross)}</td>
                      <td className="px-2 py-2">{rp(r.extra ?? 0)}</td>
                      <td className="px-2 py-2 font-semibold">{rp(c.net)}</td>
                      <td className={`px-2 py-2 text-xs font-semibold ${c.ok ? 'text-success-700' : 'text-danger-700'}`}>{c.ok ? 'Valid' : c.errors.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-ink-500">Hanya baris valid yang disimpan. Baris bermasalah tetap di daftar untuk diperbaiki; mengubah baris mana pun meminta validasi ulang.</p>
          </section>
        )}
      </div>

      {/* Desktop: panel tetap di kanan. HP: ringkasan di bawah, bisa dibuka-tutup. */}
      <aside className="hidden flex-col gap-3 rounded-2xl bg-navy-900 p-5 text-white lg:sticky lg:top-6 lg:flex">
        <h2 className="font-display text-base font-semibold">Ringkasan Bulk</h2>
        {summary}
        {primary}
      </aside>
      {/* Portal: animasi halaman (animate-enter) meninggalkan transform yang membuat `fixed` ikut menggulir bersama konten. */}
      {hydrated && createPortal(
        <div className="fixed inset-x-0 bottom-0 z-20 flex flex-col gap-2 border-t border-navy-700 bg-navy-900 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-white lg:hidden">
          <details>
            <summary className="flex min-h-9 cursor-pointer items-center justify-between text-sm font-semibold">
              <span>Ringkasan Bulk</span>
              <span className="text-orange-500">{checked ? rp(totals.laba) : `${list.length} baris`}</span>
            </summary>
            <div className="pt-2">{summary}</div>
          </details>
          {primary}
        </div>,
        document.body,
      )}
    </div>
  )
}
