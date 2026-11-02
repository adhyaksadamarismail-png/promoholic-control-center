'use client'

import { createContext, useContext, useEffect, useState, useTransition } from 'react'
import { useHydrated } from '@/components/action-form'
import { archiveAccounts, restoreAccounts, type BulkAccountResult } from './actions'

type Row = { id: string; code: string }
type Mode = 'archive' | 'restore'
const Ctx = createContext<{ selected: Set<string>; leaving: Set<string>; toggle: (id: string) => void } | null>(null)

const COPY: Record<Mode, { button: string; ask: (n: number) => string; note: string; run: (n: number) => string; busy: string; done: string; toast: (r: BulkAccountResult) => string }> = {
  archive: {
    button: 'Hapus Akun Terpilih',
    ask: (n) => `Hapus ${n} akun berikut dari daftar aktif?`,
    note: 'Akun masuk ke arsip dan tidak ditawarkan untuk transaksi baru. Transaksi, voucher, dan laporan keuangan tidak berubah; akun bisa dipulihkan kapan saja.',
    run: (n) => `Ya, arsipkan ${n} akun`,
    busy: 'Mengarsipkan…',
    done: 'diarsipkan',
    toast: (r) => `${r.done} akun diarsipkan${r.skipped ? ` · ${r.skipped} dilewati` : ''}`,
  },
  restore: {
    button: 'Pulihkan Akun Terpilih',
    ask: (n) => `Pulihkan ${n} akun berikut?`,
    note: 'Akun kembali ke daftar aktif beserta voucher, status voucher, dan riwayatnya. Tidak ada transaksi yang dibuat ulang.',
    run: (n) => `Ya, pulihkan ${n} akun`,
    busy: 'Memulihkan…',
    done: 'dipulihkan',
    toast: (r) => `${r.done} akun dipulihkan${r.skipped ? ` · ${r.skipped} dilewati` : ''}`,
  },
}

/** Pilihan akun untuk arsip/pulihkan massal (khusus owner). Membungkus daftar agar checkbox per baris berbagi state. */
export function BulkAccountProvider({ rows, mode, children }: { rows: Row[]; mode: Mode; children: React.ReactNode }) {
  const hydrated = useHydrated()
  const c = COPY[mode]
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<'select' | 'confirm'>('select')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<BulkAccountResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const chosen = rows.filter((r) => selected.has(r.id))
  const allOn = rows.length > 0 && chosen.length === rows.length

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(t)
  }, [toast])

  const toggle = (id: string) => {
    setStep('select')
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function run() {
    setError(null)
    start(async () => {
      const ids = chosen.map((x) => x.id)
      const r = mode === 'archive' ? await archiveAccounts(ids, note) : await restoreAccounts(ids)
      if (!r.ok) return setError(r.message)
      const res = r.data as BulkAccountResult
      setResult(res)
      setToast(c.toast(res))
      setLeaving(new Set(res.results.filter((x) => x.ok).map((x) => x.id))) // baris meluncur keluar sebelum daftar diperbarui
      setSelected(new Set())
      setStep('select')
      setNote('')
    })
  }

  return (
    <Ctx.Provider value={{ selected, leaving, toggle }}>
      <section className="sticky top-0 z-10 flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 shadow-sm" aria-label={mode === 'archive' ? 'Hapus akun massal' : 'Pulihkan akun massal'}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input type="checkbox" disabled={!hydrated || busy || !rows.length} checked={allOn}
              onChange={() => { setStep('select'); setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id))) }} />
            Pilih semua ({rows.length})
          </label>
          <span className="text-sm text-ink-500">{chosen.length} akun dipilih</span>
          <button type="button" disabled={!chosen.length || busy} onClick={() => setStep('confirm')}
            className={`btn-press ml-auto min-h-11 rounded-lg border px-4 text-sm font-semibold disabled:border-[#dcd2bf] disabled:text-[#6e7689] ${mode === 'archive' ? 'border-danger-700 bg-white text-danger-700' : 'border-navy-900 bg-navy-900 text-white disabled:bg-white'}`}>
            {c.button}
          </button>
        </div>

        {step === 'confirm' && chosen.length > 0 && (
          <div role="alertdialog" aria-label="Konfirmasi" className={`animate-enter flex flex-col gap-2 rounded-xl p-3 text-sm ${mode === 'archive' ? 'bg-danger-100 text-[#7a1a12]' : 'bg-cream-100 text-navy-900'}`}>
            <b>{c.ask(chosen.length)}</b>
            <p className="max-h-32 overflow-y-auto font-mono text-xs">{chosen.map((x) => x.code).join(', ')}</p>
            <p className="text-xs">{c.note}</p>
            {mode === 'archive' && (
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Alasan (opsional), mis. salah input" aria-label="Alasan"
                className="min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base text-navy-900 outline-orange-500" />
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={run} disabled={busy} className={`btn-press min-h-11 rounded-lg px-4 font-semibold text-white ${mode === 'archive' ? 'bg-danger-700' : 'bg-navy-900'}`}>
                {busy ? c.busy : c.run(chosen.length)}
              </button>
              <button type="button" onClick={() => setStep('select')} disabled={busy} className="btn-press min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 font-semibold text-navy-900">Batal</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="animate-enter rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{error}</p>}
        {result && result.skipped > 0 && (
          <div role="status" className="animate-enter flex flex-col gap-1 text-sm">
            <b>{result.done} akun {c.done} · {result.skipped} dilewati</b>
            <ul className="max-h-40 overflow-y-auto text-xs">
              {result.results.map((r) => (
                <li key={r.id} className={r.ok ? 'text-success-700' : 'text-danger-700'}>
                  <span className="font-mono">{r.code ?? r.id}</span> — {r.ok ? c.done : `dilewati: ${r.reason}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {children}
      {toast && (
        <div role="status" className="animate-enter fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-xl bg-navy-900 px-4 py-3 text-sm font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}
    </Ctx.Provider>
  )
}

/** Checkbox pilih akun pada baris daftar (hanya ada di dalam BulkAccountProvider). */
export function RowCheck({ id, code }: { id: string; code: string }) {
  const ctx = useContext(Ctx)
  const hydrated = useHydrated()
  if (!ctx) return null
  return (
    <input type="checkbox" aria-label={`Pilih akun ${code}`} disabled={!hydrated} checked={ctx.selected.has(id)} onChange={() => ctx.toggle(id)}
      data-row-check={ctx.leaving.has(id) ? 'leaving' : ''} className="size-5 shrink-0" />
  )
}
