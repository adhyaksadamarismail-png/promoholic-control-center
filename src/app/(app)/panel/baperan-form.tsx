'use client'

import { startTransition, useActionState, useState } from 'react'
import Link from 'next/link'
import { useHydrated } from '@/components/action-form'
import { CopyButton } from '@/components/copy-button'
import { dateLabel } from '@/lib/format'
import { phoneLabel } from '@/lib/baperan'
import { ruleLabel, type Rule } from '@/lib/inventory'
import { panelRestockBaperan } from './actions'

const input = 'min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base outline-orange-500'
const label = 'flex flex-col gap-1.5 text-sm font-semibold'
const hint = 'text-xs font-normal text-ink-500'
const digits = (v: string) => v.replace(/\D/g, '')
const normalizePhone = (v: string) => digits(v).replace(/^62/, '0')

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

  const shown = state === ack ? null : state
  const saved = shown?.ok ? (shown.data as Saved) : null
  const phoneNorm = normalizePhone(phone)
  const phoneOk = /^08\d{8,11}$/.test(phoneNorm)
  const costNum = cost === '' ? null : Number(cost)

  function reset() {
    setIdem(crypto.randomUUID())
    setPhone(''); setPin(''); setCost(''); setReceived(today); setUntil('')
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
      className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"
      onSubmit={(e) => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        startTransition(() => action(fd))
      }}
    >
      <input type="hidden" name="idem" value={idem} />
      <fieldset disabled={pending || !hydrated} className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:grid-cols-2 sm:p-5">
        <p className="rounded-lg bg-cream-100 px-3 py-2 text-[13px] text-ink-500 sm:col-span-2">
          Baperan adalah inventaris terpisah dari akun reguler (voucher A, B, C). Satu nomor telepon = satu akun Baperan, otomatis berisi tepat
          1 voucher {typeName} · {ruleLabel(rule)}.
        </p>
        <label className={label}>
          Nomor telepon akun
          <input name="phone" required inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0812-3456-7890" className={input} />
          <span className={hint}>{phone && !phoneOk ? 'Diawali 08, 10–13 digit.' : 'Satu nomor hanya untuk satu akun Baperan.'}</span>
        </label>
        <label className={label}>
          PIN akun (opsional)
          <input name="pin" inputMode="numeric" autoComplete="off" maxLength={8} pattern="\d{4,8}" value={pin} onChange={(e) => setPin(digits(e.target.value))} placeholder="Kosongkan bila tidak ada" className={input} />
          <span className={hint}>4–8 angka. Hanya owner yang bisa melihat PIN.</span>
        </label>
        <label className={label}>
          Modal per voucher (Rp, opsional)
          <input name="unit_cost" inputMode="numeric" value={cost} onChange={(e) => setCost(digits(e.target.value))} placeholder="Kosong = belum diisi" className={input} />
          <span className={hint}>Isi 0 bila gratis. Kosongkan bila belum diketahui (bukan dianggap Rp0).</span>
        </label>
        <label className={label}>
          Tanggal restock
          <input name="received_on" type="date" required max={today} value={received} onChange={(e) => setReceived(e.target.value)} className={input} />
        </label>
        <label className={label}>
          Tanggal berakhir masa aktif
          <input name="active_until" type="date" required min={received || undefined} value={until} onChange={(e) => setUntil(e.target.value)} className={input} />
          <span className={hint}>{until ? `Aktif sampai ${dateLabel(until, 'long')}` : 'Wajib. Voucher tidak bisa dipakai setelah tanggal ini.'}</span>
        </label>
        <label className={label}>
          Sumber pembelian / penerimaan
          <input name="source_note" required minLength={3} placeholder="mis. Reseller A, transfer 30/10" className={input} />
        </label>
        {shown && !shown.ok && <p role="alert" className="animate-enter rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12] sm:col-span-2">{shown.message}</p>}
        <div className="flex gap-2 sm:col-span-2">
          <button type="submit" className="min-h-12 flex-1 rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 hover:bg-[#ff9638] disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
            {pending ? <span className="inline-flex items-center gap-2"><span className="spinner" aria-hidden />Menyimpan…</span> : 'Catat akun Baperan'}
          </button>
          <button type="button" onClick={reset} className="min-h-12 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold hover:bg-cream-100">Kosongkan</button>
        </div>
      </fieldset>

      <aside className="flex flex-col gap-2 rounded-2xl bg-navy-900 p-5 text-sm text-white lg:sticky lg:top-6">
        <h2 className="font-display text-base font-semibold">Ringkasan restock</h2>
        <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Nomor telepon</span><b className="font-mono">{phoneOk ? phoneLabel(phoneNorm) : '—'}</b></div>
        <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Voucher dibuat</span><b>1 × {typeName}</b></div>
        <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">PIN</span><b>{pin ? 'Diisi' : 'Tidak ada'}</b></div>
        <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Restock</span><b>{received ? dateLabel(received) : '—'}</b></div>
        <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Aktif sampai</span><b>{until ? dateLabel(until, 'long') : 'Belum diisi'}</b></div>
        <div className="flex justify-between gap-3 border-b border-navy-700 py-1.5">
          <span className="text-[#c5cbd9]">Modal</span>
          <b>{costNum === null ? 'Belum diisi' : `Rp${costNum.toLocaleString('id-ID')}`}</b>
        </div>
        <div className="flex flex-col gap-0.5 pt-1">
          <span className="text-[#c5cbd9]">ID akun & voucher</span>
          <span className="font-mono text-xs">Dibuat otomatis, mis. BP-0001 · V-KKBP0001-BP01</span>
        </div>
      </aside>
    </form>
  )
}
