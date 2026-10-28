'use client'

import Link from 'next/link'
import { useHydrated } from '@/components/action-form'
import { startTransition, useActionState, useState } from 'react'
import { accountCodeError, accountKey, currentVersion, normalizeAccountCode, ruleLabel, voucherBase, type Rule } from '@/lib/inventory'
import { panelAddAccount, panelAddStock } from './actions'

type Brand = { id: string; name: string }
type VType = { id: string; brand_id: string; code: string; name: string; grp: 'main' | 'extra'; auto_per_account: number | null; sort_order: number }
type Version = Rule & { voucher_type_id: string; effective_from: string }
type Account = { id: string; brand_id: string; account_code: string }
type Cost = { brand_id: string; basis: 'credit_per_account' | 'rp_per_voucher' | 'free'; credits_per_account: number | null; rp_per_voucher: number | null }

const input = 'min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base outline-orange-500'
const label = 'flex flex-col gap-1.5 text-sm font-semibold'
const rp = (n: number) => 'Rp' + Math.round(n).toLocaleString('id-ID')

/** Sama dengan pola ID di _create_account / add_stock. ID final tetap dibuat server. */
function voucherCode(brand: string, account: string, t: VType, slot: number) {
  return `V-${voucherBase(brand, account)}-${t.code}${t.auto_per_account === 1 ? '' : String(slot).padStart(2, '0')}`
}

export function PanelForm(props: {
  mode: 'new' | 'add'
  brands: Brand[]
  types: VType[]
  versions: Version[]
  accounts: Account[]
  existingKeys: string[] // `${brand}|${identitas akun tanpa prefix}`
  maxSlots: Record<string, number> // `${accountId}|${typeId}` → slot tertinggi
  costs: Cost[]
  creditPrice: number | null
}) {
  const { mode, brands, types, versions, accounts, existingKeys, maxSlots, costs, creditPrice } = props
  const hydrated = useHydrated()
  const [state, action, pending] = useActionState(mode === 'new' ? panelAddAccount : panelAddStock, null)
  const [ack, setAck] = useState<typeof state>(null)
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [brand, setBrand] = useState(brands[0]?.id ?? '')
  const [code, setCode] = useState('')
  const [accountId, setAccountId] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [formKey, setFormKey] = useState(0)

  const account = accounts.find((a) => a.id === accountId)
  const brandId = mode === 'new' ? brand : account?.brand_id ?? ''
  const brandTypes = types.filter((t) => t.brand_id === brandId).sort((a, b) => a.sort_order - b.sort_order)
  const autoTypes = mode === 'new' ? brandTypes.filter((t) => t.auto_per_account) : []
  const manualTypes = brandTypes.filter((t) => t.auto_per_account === null)
  const fullCode = normalizeAccountCode(code)
  const codeErr = code ? accountCodeError(fullCode) : null
  const codeOk = !!code && !codeErr
  const duplicate = mode === 'new' && codeOk && existingKeys.includes(`${brandId}|${accountKey(brandId, fullCode)}`)
  const accCode = mode === 'new' ? (codeOk ? fullCode : '195678') : account?.account_code ?? ''

  const preview = [
    ...autoTypes.flatMap((t) => Array.from({ length: t.auto_per_account ?? 0 }, (_, i) => ({ t, slot: i + 1 }))),
    ...manualTypes.flatMap((t) => {
      const base = mode === 'add' && account ? maxSlots[`${account.id}|${t.id}`] ?? 0 : 0
      return Array.from({ length: qty[t.code] ?? 0 }, (_, i) => ({ t, slot: base + i + 1 }))
    }),
  ]
  const cost = costs.find((c) => c.brand_id === brandId)
  const mainCount = preview.filter((p) => p.t.grp === 'main').length
  const modalNote = !cost
    ? 'Modal brand belum dikonfigurasi owner — server akan menolak.'
    : cost.basis === 'free'
      ? 'Akun gratis: modal Rp0.'
      : cost.basis === 'rp_per_voucher'
        ? `${rp(cost.rp_per_voucher ?? 0)} per voucher × ${preview.length} = ${rp((cost.rp_per_voucher ?? 0) * preview.length)}`
        : mode === 'add'
          ? 'Modal akun sudah dicatat saat akun dibuat; tambahan voucher tidak menambah modal.'
          : creditPrice
            ? `${Number(cost.credits_per_account)} kredit × ${rp(creditPrice)} = ${rp(Number(cost.credits_per_account) * creditPrice)}, dibagi ke ${mainCount} voucher utama`
            : 'Harga kredit belum dikonfigurasi owner.'

  const shown = state === ack ? null : state
  function reset() {
    setIdem(crypto.randomUUID())
    setCode('')
    setAccountId('')
    setQty({})
    setFormKey((k) => k + 1)
    setAck(state)
  }

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

  const disabled = pending || preview.length === 0 || (mode === 'new' ? !codeOk || duplicate : !account)

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
      <fieldset disabled={pending || !hydrated} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
        {mode === 'new' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">Brand</span>
              <input type="hidden" name="brand" value={brand} />
              <div className="flex flex-wrap gap-2">
                {brands.map((b) => (
                  <button
                    type="button"
                    key={b.id}
                    aria-pressed={brand === b.id}
                    onClick={() => { setBrand(b.id); setQty({}); setCode('') }}
                    className={`min-h-11 rounded-xl border px-3.5 text-sm font-semibold ${brand === b.id ? 'border-navy-900 bg-navy-900 text-white' : 'border-[#dcd2bf] bg-white'}`}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <label className={label}>
                ID akun
                <input name="code" required maxLength={32} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="mis. 195678" className={`${input} font-mono`} autoComplete="off" />
                <span className={`text-xs font-normal ${duplicate || codeErr ? 'text-danger-700' : 'text-ink-500'}`}>
                  {duplicate
                    ? 'ID sudah terdaftar di brand ini. Gunakan "Tambah voucher ke akun yang ada".'
                    : codeErr ?? `Boleh 195678 atau ${brandId}-195678 (dianggap sama). Dicek ulang server.`}
                </span>
              </label>
              <label className={label}>
                Email / identitas (opsional)
                <input name="identity" className={input} autoComplete="off" />
              </label>
              <label className={label}>
                Masa aktif (opsional)
                <input type="date" name="active_until" className={input} />
              </label>
            </div>
          </>
        ) : (
          <label className={label}>
            Akun Panel
            <select name="account" value={accountId} onChange={(e) => { setAccountId(e.target.value); setQty({}) }} className={input} required>
              <option value="">Pilih akun…</option>
              {brands.map((b) => (
                <optgroup key={b.id} label={b.name}>
                  {accounts.filter((a) => a.brand_id === b.id && types.some((t) => t.brand_id === b.id && t.auto_per_account === null)).map((a) => (
                    <option key={a.id} value={a.id}>{a.account_code}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="text-xs font-normal text-ink-500">Hanya akun dari Panel Admin. Akun VM dikelola owner di modul Virtual Machine.</span>
          </label>
        )}

        {autoTypes.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">Voucher utama otomatis</span>
            {autoTypes.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl bg-cream-100 px-3 py-2.5 text-sm">
                <span>
                  <b>{t.name}</b>
                  <span className="block text-xs text-ink-500">{ruleLabel(currentVersion(versions, t.id))}</span>
                </span>
                <span className="rounded-full bg-navy-100 px-2.5 py-0.5 text-xs font-bold text-navy-700">{t.auto_per_account}× otomatis</span>
              </div>
            ))}
          </div>
        )}

        {brandId && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">{autoTypes.length ? 'Voucher tambahan (jumlah sesuai yang ada di akun)' : 'Jumlah voucher'}</span>
            {!manualTypes.length && <p className="text-sm text-ink-500">Brand ini tidak punya jenis voucher yang diisi manual.</p>}
            {manualTypes.map((t) => {
              const n = qty[t.code] ?? 0
              const set = (v: number) => setQty((q) => ({ ...q, [t.code]: Math.max(0, Math.min(20, v)) }))
              return (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-[#eadfcb] px-3 py-2 text-sm">
                  <span>
                    <b>{t.name}</b>
                    <span className="block text-xs text-ink-500">{ruleLabel(currentVersion(versions, t.id))}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <button type="button" aria-label={`Kurangi ${t.name}`} onClick={() => set(n - 1)} className="size-10 rounded-lg border border-[#dcd2bf] text-lg font-bold">−</button>
                    <input name={`qty_${t.code}`} value={n} readOnly aria-label={`Jumlah ${t.name}`} className="w-10 text-center font-display text-lg font-bold" />
                    <button type="button" aria-label={`Tambah ${t.name}`} onClick={() => set(n + 1)} className="size-10 rounded-lg border border-[#dcd2bf] text-lg font-bold">+</button>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {shown && !shown.ok && <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{shown.message}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={disabled} className="min-h-12 flex-1 rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]">
            {pending ? 'Menyimpan…' : mode === 'new' ? 'Simpan akun & voucher' : 'Tambah voucher'}
          </button>
          <button type="button" onClick={reset} className="min-h-12 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Kosongkan</button>
        </div>
      </fieldset>

      <aside className="flex flex-col gap-2 rounded-2xl bg-navy-900 p-5 text-sm text-white lg:sticky lg:top-6">
        <h2 className="font-display text-base font-semibold">Voucher yang akan dibuat</h2>
        <span className="text-xs text-[#c5cbd9]">ID dibuat server dan unik. Voucher utama tidak pernah dibuat dua kali untuk akun yang sama.</span>
        {!preview.length && <span className="text-[#c5cbd9]">Tidak ada voucher yang akan ditambahkan.</span>}
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {preview.map((p) => (
            <li key={`${p.t.id}-${p.slot}`} className="flex justify-between gap-2 border-b border-navy-700 py-1">
              <span className="font-mono text-xs">{voucherCode(brandId, accCode, p.t, p.slot)}</span>
              <span className="text-xs text-[#c5cbd9]">{p.t.grp === 'main' ? 'utama' : 'tambahan'}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-between pt-1"><span className="text-[#c5cbd9]">Total voucher masuk</span><b>{preview.length}</b></div>
        <div className="flex flex-col gap-0.5"><span className="text-[#c5cbd9]">Modal</span><span className="text-xs">{modalNote}</span></div>
      </aside>
    </form>
  )
}
