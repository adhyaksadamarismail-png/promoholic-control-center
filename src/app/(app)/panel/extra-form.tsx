'use client'

import { startTransition, useActionState, useState } from 'react'
import Link from 'next/link'
import { useHydrated } from '@/components/action-form'
import { currentVersion, ruleLabel, voucherBase, type Rule } from '@/lib/inventory'
import { panelRestockExtra } from './actions'

type Brand = { id: string; name: string }
type VType = { id: string; brand_id: string; code: string; name: string }
type Version = Rule & { voucher_type_id: string; effective_from: string }
type Account = { id: string; brand_id: string; account_code: string }

const input = 'min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base outline-orange-500'
const label = 'flex flex-col gap-1.5 text-sm font-semibold'

/**
 * Restock voucher tambahan (Baperan) tanpa membuat akun baru dan tanpa tiga voucher utama.
 * Akun opsional: hanya diisi bila voucher memang terikat ke akun tertentu.
 */
export function ExtraRestockForm({ brands, types, versions, accounts, today }: { brands: Brand[]; types: VType[]; versions: Version[]; accounts: Account[]; today: string }) {
  const hydrated = useHydrated()
  const [state, action, pending] = useActionState(panelRestockExtra, null)
  const [ack, setAck] = useState<typeof state>(null)
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [typeId, setTypeId] = useState(types[0]?.id ?? '')
  const [accountId, setAccountId] = useState('')
  const [qty, setQty] = useState(1)
  const [cost, setCost] = useState('')
  const [formKey, setFormKey] = useState(0)

  const type = types.find((t) => t.id === typeId)
  const brand = brands.find((b) => b.id === type?.brand_id)
  const account = accounts.find((a) => a.id === accountId)
  const shown = state === ack ? null : state
  const costNum = cost === '' ? null : Number(cost.replace(/[^\d]/g, ''))

  function reset() {
    setIdem(crypto.randomUUID())
    setAccountId('')
    setQty(1)
    setCost('')
    setFormKey((k) => k + 1)
    setAck(state)
  }

  if (!types.length) return <p className="rounded-xl bg-white p-4 text-sm text-ink-500">Belum ada jenis voucher tambahan yang bisa direstock terpisah.</p>

  if (shown?.ok)
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-success-700 bg-success-100 p-5">
        <h2 className="font-display text-lg font-semibold text-success-700">{shown.message}</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={reset} className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Input lagi</button>
          <Link href="/stock?tab=restock" className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Lihat riwayat restock</Link>
        </div>
      </div>
    )

  const base = account && brand ? voucherBase(brand.id, account.account_code) : `${brand?.id ?? ''}LOT…`
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
        <label className={`${label} sm:col-span-2`}>
          Jenis voucher
          <select name="type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setAccountId('') }} className={input}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{brands.find((b) => b.id === t.brand_id)?.name} · {t.name}</option>
            ))}
          </select>
          <span className="text-xs font-normal text-ink-500">{ruleLabel(type ? currentVersion(versions, type.id) : null)}</span>
        </label>
        <label className={label}>
          Jumlah voucher masuk
          <input name="qty" type="number" min={1} max={200} required value={qty} onChange={(e) => setQty(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} className={input} />
        </label>
        <label className={label}>
          Tanggal restock
          <input name="received_on" type="date" required max={today} defaultValue={today} className={input} />
        </label>
        <label className={label}>
          Modal per voucher (Rp)
          <input name="unit_cost" inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d]/g, ''))} placeholder="Kosong = belum diisi" className={input} />
          <span className="text-xs font-normal text-ink-500">Isi 0 bila gratis. Kosongkan bila belum diketahui (bukan dianggap Rp0).</span>
        </label>
        <label className={label}>
          Terikat ke akun (opsional)
          <select name="account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={input}>
            <option value="">Tidak terikat akun (inventaris lepas)</option>
            {accounts.filter((a) => a.brand_id === type?.brand_id).map((a) => <option key={a.id} value={a.id}>{a.account_code}</option>)}
          </select>
        </label>
        <label className={`${label} sm:col-span-2`}>
          Sumber pembelian / penerimaan
          <input name="source_note" required minLength={3} placeholder="mis. Beli dari reseller A, transfer 28/10" className={input} />
        </label>
        {shown && !shown.ok && <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12] sm:col-span-2">{shown.message}</p>}
        <div className="flex gap-2 sm:col-span-2">
          <button type="submit" className="min-h-12 flex-1 rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
            {pending ? 'Menyimpan…' : `Catat ${qty} voucher`}
          </button>
          <button type="button" onClick={reset} className="min-h-12 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Kosongkan</button>
        </div>
      </fieldset>

      <aside className="flex flex-col gap-2 rounded-2xl bg-navy-900 p-5 text-sm text-white lg:sticky lg:top-6">
        <h2 className="font-display text-base font-semibold">Ringkasan restock</h2>
        <span className="text-xs text-[#c5cbd9]">Tidak membuat akun baru dan tidak membuat voucher utama. Setiap voucher punya ID unik dan dilacak sendiri.</span>
        <div className="flex justify-between border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Voucher masuk</span><b>{qty} × {type?.name}</b></div>
        <div className="flex justify-between border-b border-navy-700 py-1.5"><span className="text-[#c5cbd9]">Akun</span><b>{account?.account_code ?? 'Tanpa akun'}</b></div>
        <div className="flex justify-between border-b border-navy-700 py-1.5">
          <span className="text-[#c5cbd9]">Modal</span>
          <b>{costNum === null ? 'Belum diisi' : `Rp${costNum.toLocaleString('id-ID')} × ${qty} = Rp${(costNum * qty).toLocaleString('id-ID')}`}</b>
        </div>
        <div className="flex flex-col gap-0.5 pt-1">
          <span className="text-[#c5cbd9]">Contoh ID voucher</span>
          <span className="font-mono text-xs">V-{base}-{type?.code}01 … {String(qty).padStart(2, '0')}</span>
        </div>
      </aside>
    </form>
  )
}
