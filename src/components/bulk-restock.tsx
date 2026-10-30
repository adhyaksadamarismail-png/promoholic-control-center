'use client'

import Link from 'next/link'
import { useRef, useState, useTransition } from 'react'
import { useHydrated } from '@/components/action-form'
import { BULK_EXAMPLE, parseBulk, type BulkMode, type BulkRow, type BulkSource } from '@/lib/bulk'
import { commitBulk, previewBulk } from '@/app/(app)/panel/bulk-actions'

type Brand = { id: string; name: string }
type Checked = {
  line: number
  ok: boolean
  error: string | null
  kind: 'new' | 'existing' | 'lot' | null
  brand: string | null
  code: string | null
  device: string | null
  number: string | null
  counts: Record<string, number>
  total: number
}
type ResultRow = { restock: string; account: string | null; account_key: string | null; items: { type: string; qty: number }[]; vouchers: number }
type Result = { batch: string; new_accounts: number; vouchers: number; total_cost: number; cost_unknown: number; repeated: boolean; rows: ResultRow[] }
type AutoType = { brand_id: string; code: string; name: string; grp: string; auto_per_account: number | null }

const MODES: { key: BulkMode; label: string; help: string }[] = [
  { key: 'new_account', label: 'Akun baru', help: 'Cukup satu ID akun per baris. Voucher utama dibuat otomatis dari Konfigurasi Voucher; voucher lain hanya bila ditulis (mis. 123456 | D25=2).' },
  { key: 'add_stock', label: 'Tambah voucher ke akun yang sudah ada', help: 'Hanya voucher yang diisi manual; akun tidak dibuat ulang dan voucher utama tidak digandakan.' },
]
// Baperan tidak lewat Bulk Restock: satu nomor telepon = satu akun, direstock di tab "Restock Baperan saja".
const input = 'min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base outline-orange-500'
const label = 'flex flex-col gap-1.5 text-sm font-semibold'
/** Baris untuk server tanpa catatan kesalahan format dari browser. */
const forServer = (r: BulkRow) => ({ line: r.line, device: r.device, code: r.code, number: r.number, items: r.items })
const rp = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID')

/** Bulk Restock: tempel teks / unggah CSV → preview tervalidasi server → konfirmasi (satu batch atomik). */
export function BulkRestock({ source, brands, costMissing = [], isOwner = false, autoTypes = [] }: {
  source: BulkSource
  brands: Brand[]
  autoTypes?: AutoType[] // jenis voucher aktif brand terkait, dari database (bukan daftar tetap)
  costMissing?: string[] // brand yang belum punya modal berlaku (Panel: semua brand; VM: brand VM)
  isOwner?: boolean
}) {
  const hydrated = useHydrated()
  const [mode, setMode] = useState<BulkMode>('new_account')
  const [brand, setBrand] = useState(source === 'panel' ? (brands.find((b) => b.id === 'KK')?.id ?? brands[0]?.id ?? '') : '')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [sourceNote, setSourceNote] = useState('')
  const [parsed, setParsed] = useState<BulkRow[]>([])
  const [checked, setChecked] = useState<Checked[] | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [busy, start] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)
  const sending = useRef(false) // cegah klik ganda sebelum state 'busy' sempat aktif

  // Panel: brand pilihan; VM: brand ditentukan per baris, jadi semua brand VM tanpa modal ditampilkan.
  const blockedBrands = (source === 'panel' ? costMissing.filter((id) => id === brand) : costMissing)
    .map((id) => brands.find((b) => b.id === id) ?? { id, name: id })
  // Voucher otomatis per akun baru menurut konfigurasi: Panel = brand pilihan; VM = brand VM (dari prop brands).
  const autoBrands = source === 'panel' ? brands.filter((b) => b.id === brand) : brands
  const autoInfo = autoBrands.map((b) => ({
    brand: b,
    auto: autoTypes.filter((t) => t.brand_id === b.id && t.grp === 'main' && t.auto_per_account),
    extra: autoTypes.filter((t) => t.brand_id === b.id && !t.auto_per_account),
  }))
  const invalidate = () => { setChecked(null); setMessage(null) }
  function reset() {
    setText(''); setFileName(''); setParsed([]); setChecked(null); setMessage(null); setResult(null)
    setUnitCost(''); setSourceNote(''); setIdem(crypto.randomUUID())
    if (fileRef.current) fileRef.current.value = ''
  }
  async function readFile(f: File | undefined) {
    if (!f) return
    if (f.size > 1024 * 1024) return setMessage({ ok: false, text: 'File CSV maksimal 1 MB.' })
    setFileName(f.name)
    setText(await f.text())
    invalidate()
  }

  function preview() {
    const rows = parseBulk(text, source)
    setParsed(rows)
    setResult(null)
    if (!rows.length) return setMessage({ ok: false, text: 'Belum ada baris data.' })
    if (rows.length > 300) return setMessage({ ok: false, text: 'Maksimal 300 baris per batch.' })
    start(async () => {
      const r = await previewBulk({ source, mode, brand: source === 'panel' ? brand : null, rows: rows.map(forServer) })
      if (!r.ok) return setMessage({ ok: false, text: r.message })
      // Kesalahan format di browser (mis. jumlah bukan angka) ikut ditampilkan sebagai baris ditolak.
      const server = r.data as Checked[]
      setChecked(server.map((c) => {
        const p = rows.find((x) => x.line === c.line)
        return p?.parseError ? { ...c, ok: false, error: p.parseError } : c
      }))
      setMessage(null)
    })
  }

  const valid = checked?.filter((c) => c.ok) ?? []
  function confirm() {
    if (!valid.length || sending.current) return
    sending.current = true
    const rows = parsed.filter((p) => valid.some((v) => v.line === p.line)).map(forServer)
    start(async () => {
      const r = await commitBulk({
        source, mode, brand: source === 'panel' ? brand : null, rows,
        unitCost: unitCost === '' ? null : Number(unitCost), sourceNote, idem,
      })
      sending.current = false
      if (!r.ok) return setMessage({ ok: false, text: r.message })
      setResult(r.data as Result)
      setMessage(null)
    })
  }

  const typeCols = [...new Set((checked ?? []).flatMap((c) => Object.keys(c.counts)))].sort((a, b) => {
    const order = ['A', 'B', 'C']
    return (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9) || a.localeCompare(b)
  })
  const summary = checked && {
    rows: checked.length,
    newAcc: valid.filter((c) => c.kind === 'new').length,
    existing: valid.filter((c) => c.kind === 'existing').length,
    vouchers: valid.reduce((a, c) => a + c.total, 0),
    rejected: checked.length - valid.length,
    dup: checked.filter((c) => c.error?.includes('duplikat')).length,
  }

  if (result)
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-success-700 bg-success-100 p-5">
        <h2 className="font-display text-lg font-semibold text-success-700">
          Batch {result.batch} tersimpan.
          {result.repeated && <span className="block text-sm font-normal">Kiriman ganda terdeteksi — data hanya disimpan sekali.</span>}
        </h2>
        <p className="text-sm text-success-700">
          {result.new_accounts} akun baru · {result.vouchers} voucher masuk · modal {rp(Number(result.total_cost))}
          {result.cost_unknown ? ` · ${result.cost_unknown} voucher modal belum diisi` : ''}
        </p>
        <div className="max-h-96 overflow-auto rounded-xl border border-success-700/30 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white text-xs uppercase tracking-[0.05em] text-ink-500">
              <tr><th className="px-3 py-2">Baris</th><th className="px-3 py-2">ID akun</th><th className="px-3 py-2">Hasil</th><th className="px-3 py-2">Keterangan</th></tr>
            </thead>
            <tbody>
              {(checked ?? []).map((c) => {
                const key = c.code && c.brand ? c.code.replace(new RegExp(`^${c.brand}-`), '') : null // ID tanpa prefix brand, seperti account_key
                const saved = c.ok ? (result.rows ?? []).filter((r) => (r.account_key ?? null) === key) : []
                const dup = !c.ok && /duplikat|sudah terdaftar|sudah dipakai/i.test(c.error ?? '')
                return (
                  <tr key={c.line} className="border-t border-[#f1eadc]">
                    <td className="px-3 py-2">{c.line}</td>
                    <td className="px-3 py-2 font-mono text-[13px]">{c.code ?? 'Tanpa akun'}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${c.ok ? 'bg-success-100 text-success-700' : dup ? 'bg-warning-100 text-warning-700' : 'bg-danger-100 text-danger-700'}`}>
                        {c.ok ? 'Berhasil' : dup ? 'Duplikat' : 'Gagal'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {c.ok
                        ? saved.map((r) => `${r.restock}: ${r.items.map((i) => `${i.type}×${i.qty}`).join(', ')}`).join(' · ') || `${c.total} voucher`
                        : `Tidak disimpan — ${c.error}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <button onClick={reset} className="min-h-11 w-fit rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Input batch baru</button>
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      <fieldset disabled={busy || !hydrated} className="grid grid-cols-1 gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5 lg:grid-cols-2">
        <div className="flex flex-col gap-1.5 lg:col-span-2">
          <span className="text-sm font-semibold">Jenis restock</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {MODES.map((m) => (
              <label key={m.key} className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3 text-sm transition-colors duration-150 ${mode === m.key ? 'border-navy-900 bg-navy-100/60' : 'border-[#dcd2bf]'}`}>
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="bulk-mode" checked={mode === m.key} onChange={() => { setMode(m.key); invalidate() }} />
                  {m.label}
                </span>
                <span className="text-xs text-ink-500">{m.help}</span>
              </label>
            ))}
          </div>
        </div>
        {source === 'panel' && (
          <label className={label}>
            Brand
            <select value={brand} onChange={(e) => { setBrand(e.target.value); invalidate() }} className={input}>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <span className="text-xs font-normal text-ink-500">Voucher dibuat mengikuti konfigurasi brand ini; jenis yang tidak ada di brand ditolak.</span>
          </label>
        )}
        {mode === 'extra_only' && (
          <>
            <label className={label}>
              Sumber pembelian / penerimaan
              <input value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} placeholder="mis. Reseller B, transfer 28/10" className={input} />
            </label>
            <label className={label}>
              Modal per voucher (Rp)
              <input value={unitCost} inputMode="numeric" onChange={(e) => setUnitCost(e.target.value.replace(/\D/g, ''))} placeholder="Kosong = belum diisi" className={input} />
            </label>
          </>
        )}
        {mode === 'new_account' && autoInfo.length > 0 && (
          <div className="flex flex-col gap-1 rounded-xl bg-cream-100 px-3 py-2.5 text-sm lg:col-span-2">
            {autoInfo.map(({ brand: b, auto, extra }) => (
              <span key={b.id}>
                <b>{b.name}:</b>{' '}
                {auto.length
                  ? `setiap akun baru otomatis mendapat ${auto.map((t) => `${t.code} ×${t.auto_per_account}`).join(', ')}`
                  : 'belum ada voucher otomatis per akun — tulis jumlahnya per baris, atau atur di Konfigurasi Voucher'}
                {extra.length > 0 && <span className="text-ink-500"> · {extra.map((t) => t.code).join(', ')} hanya bila ditulis</span>}
              </span>
            ))}
            <span className="text-xs text-ink-500">Dari Konfigurasi Voucher yang berlaku; dihitung ulang server saat validasi.</span>
          </div>
        )}
        <label className={`${label} lg:col-span-2`}>
          Data (satu akun per baris)
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setFileName(''); invalidate() }}
            rows={7}
            spellCheck={false}
            placeholder={BULK_EXAMPLE[source][mode]}
            className="w-full rounded-lg border border-[#dcd2bf] bg-white p-3 font-mono text-sm outline-orange-500"
          />
          <span className="text-xs font-normal text-ink-500">
            Pemisah kolom: <code>|</code>, koma, titik koma, atau tab. Voucher ditulis <code>KODE=jumlah</code>, mis. <code>D25=2</code>. Baperan direstock di tab &quot;Restock Baperan saja&quot;.
            {source === 'vm' && ' Format VM: device | ID akun | nomor akun | voucher… (VM-01 dibaca sebagai VD-01; nomor wajib untuk akun baru).'}
            {' '}CSV berheader juga diterima, mis. <code>akun,D25</code>.
          </span>
        </label>
        <div className="flex flex-wrap gap-2 lg:col-span-2">
          <input ref={fileRef} id={`csv-${source}`} type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
          <label htmlFor={`csv-${source}`} className="flex min-h-11 cursor-pointer items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">
            Pilih File CSV
          </label>
          {fileName && <span className="flex items-center text-sm text-ink-500">{fileName}</span>}
          <button type="button" onClick={preview} disabled={!text.trim()} className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
            {busy && !checked ? <span className="inline-flex items-center gap-2"><span className="spinner" aria-hidden />Memvalidasi…</span> : 'Validasi Data & Proses Preview'}
          </button>
          <button type="button" onClick={reset} className="min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Batalkan</button>
        </div>
      </fieldset>

      {mode === 'new_account' && blockedBrands.length > 0 && (
        <div role="status" className="flex flex-col gap-2 rounded-lg bg-warning-100 px-3 py-2.5 text-sm text-warning-700 sm:flex-row sm:items-center sm:justify-between">
          <span>
            Modal brand {blockedBrands.map((b) => b.name).join(', ')} belum dikonfigurasi, jadi batch akun baru akan ditolak saat disimpan.
            {!isOwner && ' Minta owner mengaturnya di Keuangan → Modal per Brand.'}
          </span>
          {isOwner && (
            <Link href={`/finance/brand-costs?brand=${blockedBrands[0].id}#brand-${blockedBrands[0].id}`} className="flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-navy-900 px-4 font-semibold text-white">
              Konfigurasi modal brand
            </Link>
          )}
        </div>
      )}
      {message && <p role="alert" className={`rounded-lg px-3 py-2 text-sm ${message.ok ? 'bg-success-100 text-success-700' : 'bg-danger-100 text-[#7a1a12]'}`}>{message.text}</p>}

      {busy && !checked && (
        <section aria-busy="true" aria-label="Memvalidasi data" className="flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
          <div className="skeleton h-5 w-40" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-16" />)}</div>
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-8" />)}
        </section>
      )}
      {checked && summary && (
        <section className="animate-enter flex min-w-0 flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
          <h2 className="font-display text-base font-semibold">Preview — belum disimpan</h2>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Total baris', summary.rows],
              ['Akun baru', summary.newAcc],
              ['Akun ditambah voucher', summary.existing],
              ['Total voucher masuk', summary.vouchers],
              ['Baris valid', valid.length],
              ['Ditolak', `${summary.rejected}${summary.dup ? ` (${summary.dup} duplikat)` : ''}`],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded-xl bg-cream-100 p-3">
                <dt className="text-[11px] font-bold uppercase tracking-[0.05em] text-ink-500">{k}</dt>
                <dd className="font-display text-lg font-bold">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-cream-300 text-left text-xs font-bold uppercase tracking-[0.05em] text-ink-500">
                  <th className="px-2 py-2">Baris</th>
                  {source === 'vm' && <th className="px-2 py-2">Device</th>}
                  <th className="px-2 py-2">ID akun</th>
                  <th className="px-2 py-2">Brand</th>
                  {typeCols.map((t) => <th key={t} className="px-2 py-2 text-right">{t === 'BP' ? 'Baperan' : t}</th>)}
                  <th className="px-2 py-2 text-right">Total</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {checked.map((c) => (
                  <tr key={c.line} className={`border-b border-[#f1eadc] ${c.ok ? '' : 'bg-danger-100/50'}`}>
                    <td className="px-2 py-2">{c.line}</td>
                    {source === 'vm' && <td className="px-2 py-2 font-mono text-[13px]">{c.device ?? '—'}</td>}
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-[13px]">{c.code ?? (c.kind === 'lot' ? 'Lepas' : '—')}</td>
                    <td className="px-2 py-2">{c.brand ?? '—'}</td>
                    {typeCols.map((t) => <td key={t} className="px-2 py-2 text-right">{c.counts[t] ?? 0}</td>)}
                    <td className="px-2 py-2 text-right font-semibold">{c.total}</td>
                    <td className="px-2 py-2">
                      {c.ok ? (
                        <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-bold text-success-700">
                          {c.kind === 'new' ? 'Valid · akun baru' : c.kind === 'lot' ? 'Valid · lepas' : 'Valid · akun ada'}
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-danger-700">{c.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500">
            Hanya baris valid yang disimpan, dalam satu batch atomik: bila satu baris gagal saat disimpan, seluruh batch dibatalkan.
            Modal dihitung server dari konfigurasi Modal per Brand yang berlaku saat disimpan.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={confirm} disabled={busy || !valid.length} className="min-h-12 rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
              {busy ? <span className="inline-flex items-center gap-2"><span className="spinner" aria-hidden />Menyimpan…</span> : `Konfirmasi Restock (${valid.length} baris)`}
            </button>
            <button type="button" onClick={reset} disabled={busy} className="min-h-12 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Batalkan</button>
          </div>
        </section>
      )}
    </div>
  )
}
