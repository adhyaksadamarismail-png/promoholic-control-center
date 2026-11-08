'use client'

import { createContext, useContext, useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { CheckDraw } from '@/components/action-form'
import { useHydrated } from '@/components/action-form'
import { archiveAccounts, restoreAccounts, type BulkAccountResult } from './actions'

type Row = { id: string; code: string }
type Mode = 'archive' | 'restore'
const Ctx = createContext<{ mode: Mode; selected: Set<string>; leaving: Set<string>; busy: boolean; toggle: (id: string) => void; askOne: (row: Row) => void } | null>(null)

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
  const [single, setSingle] = useState<Row | null>(null) // aksi dari tombol di satu kartu; pilihan massal tidak disentuh
  const [note, setNote] = useState('')
  const [result, setResult] = useState<BulkAccountResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const chosen = rows.filter((r) => selected.has(r.id))
  const target = single ? [single] : chosen
  const allOn = rows.length > 0 && chosen.length === rows.length

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(t)
  }, [toast])

  const close = () => { setStep('select'); setSingle(null) }
  const askOne = (row: Row) => { setError(null); setSingle(row); setStep('confirm') }
  const toggle = (id: string) => {
    setStep('select')
    setSingle(null)
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function run() {
    setError(null)
    start(async () => {
      const ids = target.map((x) => x.id)
      const r = mode === 'archive' ? await archiveAccounts(ids, note) : await restoreAccounts(ids)
      if (!r.ok) return setError(r.message)
      const res = r.data as BulkAccountResult
      setResult(res)
      setToast(c.toast(res))
      setLeaving(new Set(res.results.filter((x) => x.ok).map((x) => x.id))) // baris meluncur keluar sebelum daftar diperbarui
      if (!single) setSelected(new Set())
      else setSelected((s) => { const n = new Set(s); n.delete(single.id); return n })
      setSingle(null)
      setStep('select')
      setNote('')
    })
  }

  return (
    <Ctx.Provider value={{ mode, selected, leaving, busy, toggle, askOne }}>
      <section className="sticky top-[calc(4rem+env(safe-area-inset-top))] z-10 md:top-3 flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 shadow-sm" aria-label={mode === 'archive' ? 'Hapus akun massal' : 'Pulihkan akun massal'}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input type="checkbox" disabled={!hydrated || busy || !rows.length} checked={allOn}
              onChange={() => { setStep('select'); setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id))) }} />
            Pilih semua ({rows.length})
          </label>
          <span className="text-sm text-ink-500">{chosen.length} akun dipilih</span>
          <button type="button" disabled={!chosen.length || busy} onClick={() => { setSingle(null); setStep('confirm') }}
            className={`btn-press ml-auto min-h-11 rounded-lg border px-4 text-sm font-semibold disabled:border-[#dcd2bf] disabled:text-[#6e7689] ${mode === 'archive' ? 'border-danger-700 bg-white text-danger-700' : 'border-navy-900 bg-navy-900 text-white disabled:bg-white'}`}>
            {c.button}
          </button>
        </div>

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
      <ConfirmModal open={step === 'confirm' && target.length > 0} onClose={() => !busy && close()} danger={mode === 'archive'}>
        <b className="text-[15px]">{c.ask(target.length)}</b>
        <p className="max-h-32 overflow-y-auto rounded-lg bg-cream-100 px-3 py-2 font-mono text-xs">{target.map((x) => x.code).join(', ')}</p>
        <p className="text-xs text-ink-500">{c.note}</p>
        {mode === 'archive' && (
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Alasan (opsional), mis. salah input" aria-label="Alasan"
            className="min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base text-navy-900 outline-orange-500" />
        )}
        {error && <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={close} disabled={busy} className="btn-press min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold text-navy-900">Batal</button>
          <button type="button" onClick={run} disabled={busy} className={`btn-press flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white ${mode === 'archive' ? 'bg-danger-700' : 'bg-navy-900'}`}>
            {busy && <span className="spinner" aria-hidden />}
            {busy ? c.busy : c.run(target.length)}
          </button>
        </div>
      </ConfirmModal>
      {children}
      {toast && (
        <div role="status" className="animate-enter fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 md:bottom-[calc(1rem+env(safe-area-inset-bottom))] mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-xl bg-navy-900 px-4 py-3 text-sm font-semibold text-white shadow-lg">
          <span className="flex items-center gap-2"><CheckDraw />{toast}</span>
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

/** Dialog konfirmasi hapus/pulihkan: <dialog> bawaan (fokus terkunci, Escape = batal) dengan animasi masuk/keluar. */
function ConfirmModal({ open, onClose, danger, children }: { open: boolean; onClose: () => void; danger: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) { setClosing(false); d.showModal() }
    if (!open && d.open) {
      setClosing(true)
      const t = window.setTimeout(() => { d.close(); setClosing(false) }, 140)
      return () => window.clearTimeout(t)
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label="Konfirmasi"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      className={`confirm-dialog m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-navy-900 shadow-2xl ${closing ? 'closing' : ''}`}
    >
      <div className={`flex flex-col gap-3 border-t-4 p-5 ${danger ? 'border-danger-700' : 'border-navy-900'}`}>{children}</div>
    </dialog>
  )
}

/** Aksi per kartu: Lihat Voucher (semua peran) dan Hapus/Pulihkan Akun (owner). Tombol terpisah, bukan klik kartu. */
export function CardActions({ id, code, href }: { id: string; code: string; href: string }) {
  const ctx = useContext(Ctx)
  const hydrated = useHydrated()
  return (
    <span className={`mt-auto grid gap-2 ${ctx ? 'grid-cols-2' : 'grid-cols-1'}`}>
      <Link href={href} className="btn-press flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg bg-navy-900 px-2 text-xs font-semibold text-white hover:bg-navy-700">
        Lihat Voucher
      </Link>
      {ctx && (
        <button
          type="button"
          disabled={!hydrated || ctx.busy}
          onClick={() => ctx.askOne({ id, code })}
          aria-label={`${ctx.mode === 'archive' ? 'Hapus' : 'Pulihkan'} akun ${code}`}
          className={`btn-press flex min-h-10 items-center justify-center whitespace-nowrap rounded-lg border px-2 text-xs font-semibold ${ctx.mode === 'archive' ? 'border-danger-700/40 bg-white text-danger-700 hover:bg-danger-100' : 'border-navy-900 bg-white text-navy-900 hover:bg-cream-100'}`}
        >
          {ctx.mode === 'archive' ? 'Hapus Akun' : 'Pulihkan'}
        </button>
      )}
    </span>
  )
}
