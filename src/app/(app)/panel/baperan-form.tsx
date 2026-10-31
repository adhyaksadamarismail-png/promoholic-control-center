'use client'

import { startTransition, useActionState, useState } from 'react'
import Link from 'next/link'
import { useHydrated } from '@/components/action-form'
import { CopyButton } from '@/components/copy-button'
import { dateLabel } from '@/lib/format'
import { phoneLabel } from '@/lib/baperan'
import { ruleLabel, type Rule } from '@/lib/inventory'
import { panelRestockBaperan } from './actions'

// Semua input sama tinggi (termasuk input tanggal di Safari iPad) dan setiap field punya ruang petunjuk yang sama,
// sehingga baris kiri & kanan tetap sejajar.
const input = 'block h-11 w-full appearance-none rounded-lg border border-[#dcd2bf] bg-white px-3 text-left text-base leading-[2.75rem] outline-orange-500'

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm font-semibold">
      {label}
      {children}
      <span className="min-h-8 text-xs font-normal leading-4 text-ink-500">{hint}</span>
    </label>
  )
}
const digits = (v: string) => v.replace(/\D/g, '')
const normalizePhone = (v: string) => digits(v).replace(/^62/, '0').replace(/^(8\d{8,11})$/, '0$1')

type Saved = { restock: string; account: string; voucher: string; repeated: boolean }

/**
 * Restock Baperan: satu nomor telepon = satu akun Baperan dengan tepat 1 voucher Baperan (ID akun & voucher otomatis).
 * Terpisah dari akun reguler (voucher A, B, C). Semua aturan diperiksa ulang di database (restock_baperan).
 */
export function BaperanRestockForm({ typeName, rule, today }: { typeName: string | null; rule: Rule | null; today: string }) {
  const hydrated = useHydrated()
  const [state, action, pending] = useActionState(panelRestockBaperan, null)
  const [ack, setAck] = useState<typeof state>(null)
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [formKey, setFormKey] = useState(0)
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [cost, setCost] = useState('')
  const [received, setReceived] = useState(today)
  const [until, setUntil] = useState('')
  const [source, setSource] = useState('')

  const shown = state === ack ? null : state
  const saved = shown?.ok ? (shown.data as Saved) : null
  const phoneNorm = normalizePhone(phone)
  const phoneOk = /^08\d{8,11}$/.test(phoneNorm)
  const costNum = cost === '' ? null : Number(cost)

  function reset() {
    setIdem(crypto.randomUUID())
    setPhone(''); setPin(''); setCost(''); setReceived(today); setUntil(''); setSource('')
    setFormKey((k) => k + 1)
    setAck(state)
  }

  if (!typeName) return <p className="rounded-xl bg-white p-4 text-sm text-ink-500">Jenis voucher Baperan belum aktif di Konfigurasi Voucher.</p>

  if (saved)
    return (
      <div className="animate-enter flex flex-col gap-3 rounded-2xl border border-success-700 bg-success-100 p-5">
        <h2 className="font-display text-lg font-semibold text-success-700">
          {saved.restock} tersimpan: akun {saved.account} dengan 1 voucher Baperan.
          {saved.repeated && <span className="block text-sm font-normal">Kiriman ganda terdeteksi — data hanya disimpan sekali.</span>}
        </h2>
        <dl className="grid grid-cols-1 gap-2 text-sm text-success-700 sm:grid-cols-3">
          <div><dt className="text-xs">Nomor telepon</dt><dd className="flex items-center gap-2 font-mono font-semibold">{phoneLabel(phoneNorm)}<CopyButton value={phoneNorm} /></dd></div>
          <div><dt className="text-xs">ID voucher</dt><dd className="font-mono font-semibold">{saved.voucher}</dd></div>
          <div><dt className="text-xs">Aktif sampai</dt><dd className="font-semibold">{until ? dateLabel(until, 'long') : '—'}</dd></div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button onClick={reset} className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Input akun berikutnya</button>
          <Link href="/accounts?view=baperan" className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Lihat inventaris Baperan</Link>
        </div>
      </div>
    )

  return (
    <form
      key={formKey}
      className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        startTransition(() => action(fd))
      }}
    >
      <input type="hidden" name="idem" value={idem} />
      <fieldset disabled={pending || !hydrated} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
        <div className="flex flex-col gap-1 rounded-lg bg-cream-100 px-3 py-2.5 text-[13px] text-ink-500 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span>
            Satu nomor telepon = satu akun Baperan dengan tepat 1 voucher {typeName} · {ruleLabel(rule)}. Terpisah dari akun reguler (A, B, C).
          </span>
          <Link href="/panel?mode=bulk&bulk=baperan" className="shrink-0 font-semibold text-orange-700">Banyak akun? Bulk Restock →</Link>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          <Field label="Nomor telepon akun" hint={phone && !phoneOk ? 'Diawali 08, 10–13 digit.' : 'Wajib. Satu nomor hanya untuk satu akun.'}>
            <input name="phone" required inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0812-3456-7890" className={input} />
          </Field>
          <Field label="PIN akun (opsional)" hint="4–8 angka. Hanya owner yang bisa melihat PIN.">
            <input name="pin" inputMode="numeric" autoComplete="off" maxLength={8} pattern="\d{4,8}" value={pin} onChange={(e) => setPin(digits(e.target.value))} placeholder="Kosongkan bila tidak ada" className={input} />
          </Field>
          <Field label="Tanggal restock" hint="Tidak boleh setelah hari ini.">
            <input name="received_on" type="date" required max={today} value={received} onChange={(e) => setReceived(e.target.value)} className={input} />
          </Field>
          <Field label="Tanggal berakhir masa aktif" hint={until ? `Aktif sampai ${dateLabel(until, 'long')}` : 'Wajib. Voucher tidak bisa dipakai setelah tanggal ini.'}>
            <input name="active_until" type="date" required min={received || undefined} value={until} onChange={(e) => setUntil(e.target.value)} className={input} />
          </Field>
          <Field label="Modal per voucher (opsional)" hint="Rp0 bila gratis. Kosong = belum diisi, bukan Rp0.">
            <input name="unit_cost" inputMode="numeric" value={cost} onChange={(e) => setCost(digits(e.target.value))} placeholder="mis. 3000" className={input} />
          </Field>
          <Field label="Sumber pembelian / penerimaan (opsional)" hint="mis. nama reseller atau keterangan transfer.">
            <input name="source_note" value={source} onChange={(e) => setSource(e.target.value)} placeholder="mis. Reseller A" className={input} />
          </Field>
        </div>
        {shown && !shown.ok && <p role="alert" className="animate-enter rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{shown.message}</p>}
        <div className="flex gap-2">
          <button type="submit" className="min-h-12 flex-1 rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 hover:bg-[#ff9638] disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
            {pending ? <span className="inline-flex items-center gap-2"><span className="spinner" aria-hidden />Menyimpan…</span> : 'Catat akun Baperan'}
          </button>
          <button type="button" onClick={reset} className="min-h-12 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold hover:bg-cream-100">Kosongkan</button>
        </div>
      </fieldset>

      <aside className="flex flex-col gap-1 rounded-2xl bg-navy-900 p-5 text-sm text-white lg:sticky lg:top-6">
        <h2 className="pb-1 font-display text-base font-semibold">Ringkasan restock</h2>
        {[
          ['Nomor telepon', <span key="p" className="font-mono">{phoneOk ? phoneLabel(phoneNorm) : '—'}</span>],
          ['Voucher dibuat', `1 × ${typeName}`],
          ['Ketentuan', ruleLabel(rule)],
          ['PIN', pin ? 'Diisi' : 'Tidak ada'],
          ['Restock', received ? dateLabel(received) : '—'],
          ['Aktif sampai', until ? dateLabel(until, 'long') : 'Belum diisi'],
          ['Modal', costNum === null ? 'Belum diisi' : `Rp${costNum.toLocaleString('id-ID')}`],
          ['Sumber', source.trim() || '—'],
        ].map(([k, v]) => (
          <div key={k as string} className="flex items-start justify-between gap-3 border-b border-navy-700 py-2">
            <span className="shrink-0 text-[#c5cbd9]">{k}</span>
            <b className="min-w-0 text-right">{v}</b>
          </div>
        ))}
        <div className="flex flex-col gap-0.5 pt-2">
          <span className="text-[#c5cbd9]">ID akun & voucher</span>
          <span className="font-mono text-xs">Dibuat otomatis, mis. BP-0001 · V-KKBP0001-BP01</span>
        </div>
      </aside>
    </form>
  )
}
