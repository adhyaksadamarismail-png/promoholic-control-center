'use client'

import { createContext, useContext, useState, useTransition } from 'react'
import { useHydrated } from '@/components/action-form'
import { bulkDeleteAccounts, type BulkDeleteResult } from './actions'

type Row = { id: string; code: string }
const Ctx = createContext<{ selected: Set<string>; toggle: (id: string) => void } | null>(null)

/** Pilihan akun untuk hapus massal (khusus owner). Membungkus daftar akun agar checkbox per baris berbagi state. */
export function BulkDeleteProvider({ rows, children }: { rows: Row[]; children: React.ReactNode }) {
  const hydrated = useHydrated()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<'select' | 'confirm'>('select')
  const [result, setResult] = useState<BulkDeleteResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const chosen = rows.filter((r) => selected.has(r.id))
  const allOn = rows.length > 0 && chosen.length === rows.length

  const toggle = (id: string) => {
    setStep('select')
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function run() {
    setError(null)
    start(async () => {
      const r = await bulkDeleteAccounts(chosen.map((c) => c.id))
      if (!r.ok) return setError(r.message)
      setResult(r.data as BulkDeleteResult)
      setSelected(new Set())
      setStep('select')
    })
  }

  return (
    <Ctx.Provider value={{ selected, toggle }}>
      <section className="sticky top-0 z-10 flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 shadow-sm" aria-label="Hapus akun massal">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input type="checkbox" disabled={!hydrated || busy || !rows.length} checked={allOn}
              onChange={() => { setStep('select'); setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id))) }} />
            Pilih semua ({rows.length})
          </label>
          <span className="text-sm text-ink-500">{chosen.length} akun dipilih</span>
          <button type="button" disabled={!chosen.length || busy} onClick={() => setStep('confirm')}
            className="ml-auto min-h-11 rounded-lg border border-danger-700 bg-white px-4 text-sm font-semibold text-danger-700 disabled:border-[#dcd2bf] disabled:text-[#6e7689]">
            Hapus Akun Terpilih
          </button>
        </div>

        {step === 'confirm' && chosen.length > 0 && (
          <div role="alertdialog" aria-label="Konfirmasi hapus akun" className="flex flex-col gap-2 rounded-xl bg-danger-100 p-3 text-sm text-[#7a1a12]">
            <b>Hapus {chosen.length} akun berikut beserta vouchernya?</b>
            <p className="max-h-32 overflow-y-auto font-mono text-xs">{chosen.map((c) => c.code).join(', ')}</p>
            <p className="text-xs">Akun yang punya transaksi atau histori selain restock akan dilewati beserta alasannya. Tindakan ini tidak bisa dibatalkan.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={run} disabled={busy} className="min-h-11 rounded-lg bg-danger-700 px-4 font-semibold text-white">
                {busy ? 'Menghapus…' : `Ya, hapus ${chosen.length} akun`}
              </button>
              <button type="button" onClick={() => setStep('select')} disabled={busy} className="min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 font-semibold text-navy-900">Batal</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{error}</p>}
        {result && (
          <div role="status" className="flex flex-col gap-1 text-sm">
            <b>{result.deleted} akun dihapus · {result.skipped} dilewati</b>
            <ul className="max-h-48 overflow-y-auto text-xs">
              {result.results.map((r) => (
                <li key={r.id} className={r.ok ? 'text-success-700' : 'text-danger-700'}>
                  <span className="font-mono">{r.code ?? r.id}</span> — {r.ok ? `berhasil dihapus (${r.vouchers} voucher)` : `gagal: ${r.reason}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {children}
    </Ctx.Provider>
  )
}

/** Checkbox pilih akun pada baris daftar (hanya ada di dalam BulkDeleteProvider). */
export function RowCheck({ id, code }: { id: string; code: string }) {
  const ctx = useContext(Ctx)
  const hydrated = useHydrated()
  if (!ctx) return null
  return (
    <input type="checkbox" aria-label={`Pilih akun ${code}`} disabled={!hydrated} checked={ctx.selected.has(id)} onChange={() => ctx.toggle(id)}
      className="size-5 shrink-0" />
  )
}
