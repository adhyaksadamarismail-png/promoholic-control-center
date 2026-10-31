'use client'

import Link from 'next/link'
import { useHydrated } from '@/components/action-form'
import { startTransition, useActionState, useMemo, useState } from 'react'
import { currentVersion, previewDiscount, ruleLabel, stockLevel, type Rule } from '@/lib/inventory'
import { createOrder } from './actions'
import { baperanIdentity, baperanStatus } from '@/lib/baperan'

type Brand = { id: string; name: string }
type Account = { id: string; brand_id: string; account_code: string; source: 'vm' | 'panel'; active_until: string | null; inventory: string; account_number: string | null }
type Voucher = { id: string; code: string; account_id: string; voucher_type_id: string; grp: 'main' | 'extra'; allocated_cost: number | string | null }
type VType = { id: string; brand_id: string; code: string; name: string; grp: 'main' | 'extra'; sort_order: number }
type Version = Rule & { id: string; voucher_type_id: string; effective_from: string }

const rp = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? '—' : (n < 0 ? '−Rp' : 'Rp') + Math.abs(Math.round(n)).toLocaleString('id-ID'))
const num = (v: string) => {
  const d = v.replace(/[^\d]/g, '')
  return d ? Number(d) : null
}
const input = 'min-h-11 w-full rounded-lg border border-[#dcd2bf] bg-white px-3 text-base outline-orange-500'
const label = 'flex flex-col gap-1.5 text-sm font-semibold'

// Akun Baperan selalu berisi satu voucher, jadi indikator stok hanya untuk akun reguler.
const STOCK = {
  cukup: { label: 'Stok cukup', dot: 'bg-[#4fb286]' },
  menipis: { label: 'Stok menipis', dot: 'bg-[#f5b544]' },
}

function StockDot({ level }: { level: keyof typeof STOCK }) {
  return <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${STOCK[level].dot}`} />
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-cream-300 bg-white p-4 sm:p-5">
      <h2 className="flex items-center gap-2.5 font-display text-base font-semibold">
        <span className="flex size-7 items-center justify-center rounded-full bg-navy-900 text-sm text-white">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Money({ value, onChange, name, placeholder }: { value: number | null; onChange: (v: number | null) => void; name: string; placeholder?: string }) {
  return (
    <div className="flex items-center rounded-lg border border-[#dcd2bf] bg-white focus-within:outline-2 focus-within:outline-orange-500">
      <span className="pl-3 text-sm text-ink-500">Rp</span>
      <input
        name={name}
        inputMode="numeric"
        placeholder={placeholder}
        className="min-h-11 w-full rounded-lg bg-transparent px-2 text-base outline-none"
        value={value === null ? '' : value.toLocaleString('id-ID')}
        onChange={(e) => onChange(num(e.target.value))}
      />
    </div>
  )
}

export function OrderForm({ brands, accounts, vouchers, types, versions }: { brands: Brand[]; accounts: Account[]; vouchers: Voucher[]; types: VType[]; versions: Version[] }) {
  const hydrated = useHydrated()
  const [state, action, pending] = useActionState(createOrder, null)
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [formKey, setFormKey] = useState(0)
  const [brand, setBrand] = useState(brands.find((b) => vouchers.some((v) => accounts.find((a) => a.id === v.account_id)?.brand_id === b.id))?.id ?? brands[0]?.id)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [voucherId, setVoucherId] = useState<string | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  const [sell, setSell] = useState<number | null>(null)
  const [extra, setExtra] = useState<number | null>(0)
  const [manual, setManual] = useState<number | null>(null)
  const [override, setOverride] = useState<number | null>(null)
  const [status, setStatus] = useState<'confirmed' | 'draft'>('confirmed')
  const [sent, setSent] = useState<{ account: string; voucher: string } | null>(null)
  const [ack, setAck] = useState<typeof state>(null) // hasil yang sudah ditutup lewat "Order berikutnya"

  const typeOf = (id: string) => types.find((t) => t.id === id)
  const availByAccount = useMemo(() => {
    const m = new Map<string, Voucher[]>()
    vouchers.forEach((v) => m.set(v.account_id, [...(m.get(v.account_id) ?? []), v]))
    return m
  }, [vouchers])
  const brandAccounts = accounts.filter((a) => a.brand_id === brand && availByAccount.has(a.id))
  const account = accounts.find((a) => a.id === accountId) ?? null
  const accVouchers = (account ? availByAccount.get(account.id) ?? [] : []).sort(
    (a, b) => (typeOf(a.voucher_type_id)?.sort_order ?? 0) - (typeOf(b.voucher_type_id)?.sort_order ?? 0) || a.code.localeCompare(b.code),
  )
  const ruleFor = (v: Voucher) => currentVersion(versions, v.voucher_type_id) ?? null
  const eligible = (v: Voucher) => !menu || !ruleFor(v)?.min_purchase || menu >= (ruleFor(v)?.min_purchase ?? 0)
  // Disarankan: syarat minimum tertinggi yang masih terpenuhi (voucher dengan syarat rendah disimpan untuk order kecil).
  const recommended = menu
    ? [...accVouchers].filter(eligible).sort((a, b) => (ruleFor(b)?.min_purchase ?? 0) - (ruleFor(a)?.min_purchase ?? 0))[0]?.id
    : undefined
  const voucher = accVouchers.find((v) => v.id === voucherId) ?? null
  const rule = voucher ? ruleFor(voucher) : null
  const pv = previewDiscount(menu ?? 0, rule, manual)
  const after = override ?? (pv.discount !== null && menu ? menu - pv.discount : null)
  const costUnknown = !!voucher && voucher.allocated_cost === null
  const cost = voucher ? Number(voucher.allocated_cost ?? 0) : 0
  const hpp = after !== null ? after + cost : null
  const gross = hpp !== null && sell !== null ? sell - hpp : null
  const net = gross !== null ? gross - (extra ?? 0) : null
  const reasons = [...pv.reasons, ...(costUnknown ? ['Modal voucher belum diisi'] : []), ...(override !== null && pv.discount !== null && menu && override !== menu - pv.discount ? ['Harga merchant berbeda dari hitungan voucher'] : [])]
  const shown = state === ack ? null : state
  const done = shown?.ok ? (shown.data as string) : null

  function reset() {
    setIdem(crypto.randomUUID())
    setFormKey((k) => k + 1)
    setAccountId(null)
    setVoucherId(null)
    setMenu(null)
    setSell(null)
    setExtra(0)
    setManual(null)
    setOverride(null)
    setStatus('confirmed')
    setAck(state)
  }

  if (done && sent)
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-success-700 bg-success-100 p-5">
        <h2 className="font-display text-lg font-semibold text-success-700">{shown?.message}</h2>
        <p className="text-sm text-success-700">
          Voucher {sent.voucher}. Nilai tersimpan adalah hasil hitungan server.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/accounts/${sent.account}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">
            Lihat di detail akun
          </Link>
          <button onClick={reset} className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">
            Order berikutnya
          </button>
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
        if (account && voucher) setSent({ account: account.id, voucher: voucher.code })
        startTransition(() => action(fd))
      }}
    >
      <input type="hidden" name="idem" value={idem} />
      <input type="hidden" name="voucher" value={voucherId ?? ''} />
      <fieldset disabled={pending || !hydrated} className="flex min-w-0 flex-col gap-4">
        <Step n={1} title="Brand">
          <div className="flex flex-wrap gap-2">
            {brands.map((b) => {
              const n = vouchers.filter((v) => accounts.find((a) => a.id === v.account_id)?.brand_id === b.id).length
              return (
                <button
                  type="button"
                  key={b.id}
                  aria-pressed={brand === b.id}
                  onClick={() => { setBrand(b.id); setAccountId(null); setVoucherId(null) }}
                  className={`flex min-h-12 flex-col items-start justify-center rounded-xl border px-3.5 py-1.5 text-left ${brand === b.id ? 'border-navy-900 bg-navy-900 text-white' : 'border-[#dcd2bf] bg-white'}`}
                >
                  <span className="text-sm font-semibold">{b.name}</span>
                  <span className={`text-xs ${brand === b.id ? 'text-[#c5cbd9]' : 'text-ink-500'}`}>{n} tersedia</span>
                </button>
              )
            })}
          </div>
        </Step>

        <Step n={2} title="ID akun">
          {!brandAccounts.length && <p className="text-sm text-ink-500">Tidak ada akun dengan voucher tersedia untuk brand ini.</p>}
          {brandAccounts.some((a) => a.inventory !== 'baperan') && (
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
              <span className="flex items-center gap-1.5"><StockDot level="cukup" />Stok cukup</span>
              <span className="flex items-center gap-1.5"><StockDot level="menipis" />Sisa ≤2 voucher</span>
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {brandAccounts.map((a) => {
              const level = a.inventory === 'baperan' ? null : stockLevel(availByAccount.get(a.id)?.length ?? 0)
              return (
              <button
                type="button"
                key={a.id}
                aria-pressed={accountId === a.id}
                onClick={() => { setAccountId(a.id); setVoucherId(null) }}
                className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left ${accountId === a.id ? 'border-orange-500 bg-orange-100' : 'border-[#dcd2bf] bg-white'}`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="min-w-0 font-mono text-sm font-semibold [overflow-wrap:anywhere]">{a.inventory === 'baperan' ? baperanIdentity(a).label : a.account_code}</span>
                  {level && <StockDot level={level} />}
                </span>
                {level && <span className="sr-only">{STOCK[level].label}.</span>}
                <span className="text-xs text-ink-500">
                  {a.inventory === 'baperan' ? (a.account_number ? `Baperan · ${a.account_code}` : 'Baperan · ID Akun') : `${availByAccount.get(a.id)?.length} voucher · ${a.source === 'vm' ? 'VM' : 'Panel'}`}
                  {a.active_until && ` · s/d ${a.active_until.slice(8, 10)}/${a.active_until.slice(5, 7)}`}
                </span>
                {a.inventory === 'baperan' && baperanStatus(a.active_until) === 'segera' && (
                  <span className="mt-1 rounded-full bg-warning-100 px-2 py-0.5 text-[11px] font-bold text-warning-700">Segera kedaluwarsa</span>
                )}
                {level === 'menipis' && (
                  <span aria-hidden className="mt-1 self-end rounded-full bg-warning-100 px-2 py-0.5 text-[11px] font-bold text-warning-700 ring-1 ring-inset ring-warning-700/15">MENIPIS</span>
                )}
              </button>
              )
            })}
          </div>
        </Step>

        <Step n={3} title="Customer & referensi">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className={label}>Nama customer<input name="customer_name" required className={input} autoComplete="off" /></label>
            <label className={label}>Nomor WhatsApp<input name="customer_wa" required inputMode="tel" placeholder="0812-3456-7890" className={input} autoComplete="off" /></label>
            <label className={label}>ID / referensi order<input name="ref" className={input} placeholder="Opsional" autoComplete="off" /></label>
          </div>
        </Step>

        <Step n={4} title="Harga menu di merchant">
          <label className={label}>
            Harga asli menu (aktual)
            <Money name="menu_price" value={menu} onChange={setMenu} placeholder="0" />
          </label>
        </Step>

        <Step n={5} title="Pilih voucher spesifik">
          {!account && <p className="text-sm text-ink-500">Pilih akun dulu.</p>}
          {account && (
            <>
              <p className="text-sm text-ink-500">Disarankan: syarat minimum tertinggi yang masih terpenuhi.</p>
              {(['main', 'extra'] as const).map((g) => {
                const list = accVouchers.filter((v) => v.grp === g)
                if (!list.length) return null
                return (
                  <div key={g} className="flex flex-col gap-2">
                    <span className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">{g === 'main' ? 'Voucher utama' : 'Voucher tambahan'}</span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {list.map((v) => {
                        const ok = eligible(v)
                        const r = ruleFor(v)
                        return (
                          <button
                            type="button"
                            key={v.id}
                            disabled={!ok}
                            aria-pressed={voucherId === v.id}
                            onClick={() => setVoucherId(v.id)}
                            className={`flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${voucherId === v.id ? 'border-orange-500 bg-orange-100' : 'border-[#dcd2bf] bg-white'}`}
                          >
                            <span className="flex w-full items-center justify-between gap-2">
                              <span className="font-semibold">{typeOf(v.voucher_type_id)?.name}</span>
                              {recommended === v.id && <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[11px] font-bold text-navy-900">Disarankan</span>}
                            </span>
                            <span className="text-xs text-ink-500">{ruleLabel(r)}</span>
                            <span className="font-mono text-xs text-ink-500">{v.code}</span>
                            {!ok && <span className="text-xs font-semibold text-danger-700">Harga di bawah minimum</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {menu && !accVouchers.some(eligible) && (
                <p className="rounded-lg bg-warning-100 px-3 py-2 text-sm text-warning-700">Tidak ada voucher di akun ini yang memenuhi syarat. Pilih akun lain atau ubah order.</p>
              )}
            </>
          )}
        </Step>

        <Step n={6} title="Potongan, harga jual & status">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={label}>
              Potongan voucher
              {pv.manualNeeded ? (
                <Money name="manual_discount" value={manual} onChange={setManual} placeholder="Isi potongan manual" />
              ) : (
                <div className="flex min-h-11 items-center rounded-lg bg-cream-100 px-3 text-base">{rp(pv.discount)}</div>
              )}
              <span className="text-xs font-normal text-ink-500">
                {pv.error ?? (pv.manualNeeded ? 'Ketentuan belum dikonfigurasi: isi manual, order ditandai untuk ditinjau owner.' : 'Dihitung otomatis dari versi aturan yang berlaku.')}
              </span>
            </label>
            <label className={label}>
              Harga setelah diskon (merchant)
              <Money name="price_after_override" value={override} onChange={setOverride} placeholder={after !== null ? after.toLocaleString('id-ID') : '0'} />
              <span className="text-xs font-normal text-ink-500">Kosongkan bila sama dengan hitungan. Isi bila merchant menagih berbeda.</span>
            </label>
            <label className={label}>
              Harga jual Promo.Holic
              <Money name="sell_price" value={sell} onChange={setSell} placeholder="0" />
              <span className="text-xs font-normal text-ink-500">Terpisah dari harga merchant.</span>
            </label>
            <label className={label}>
              Biaya tambahan
              <Money name="extra_cost" value={extra} onChange={setExtra} placeholder="0" />
              <span className="text-xs font-normal text-ink-500">Ongkir, biaya layanan, dll.</span>
            </label>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-semibold">Status transaksi</legend>
            <div className="flex flex-col gap-2 sm:flex-row">
              {(['confirmed', 'draft'] as const).map((s) => (
                <label key={s} className={`flex min-h-11 flex-1 items-center gap-2 rounded-lg border px-3 text-sm ${status === s ? 'border-navy-900 bg-navy-100' : 'border-[#dcd2bf]'}`}>
                  <input type="radio" name="status" value={s} checked={status === s} onChange={() => setStatus(s)} />
                  {s === 'confirmed' ? 'Dikonfirmasi: voucher terpakai' : 'Draft: voucher dipesan'}
                </label>
              ))}
            </div>
          </fieldset>
          {/* HP: panel perhitungan ada di bawah form, jadi ringkasannya ditampilkan di sini sebelum menyimpan. */}
          <div className="flex flex-col gap-1 rounded-xl bg-navy-900 p-3.5 text-sm text-white lg:hidden">
            <div className="flex justify-between"><span className="text-[#c5cbd9]">Bayar ke merchant</span><b>{rp(after)}</b></div>
            <div className="flex justify-between"><span className="text-[#c5cbd9]">HPP (merchant + modal)</span><b>{rp(hpp)}</b></div>
            <div className="flex justify-between"><span className="font-semibold">Laba bersih</span><b className="font-display text-lg text-orange-500">{rp(net)}</b></div>
            {reasons.length > 0 && <span className="text-xs font-semibold text-[#ffd8a8]">Order akan ditandai untuk ditinjau owner.</span>}
          </div>
          {shown && !shown.ok && <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-[#7a1a12]">{shown.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={!voucher || !!pv.error || (pv.manualNeeded && manual === null) || sell === null}
              className="min-h-12 flex-1 rounded-lg bg-orange-500 px-5 font-semibold text-navy-900 disabled:bg-[#e7e2d8] disabled:text-[#6e7689]"
            >
              {pending ? 'Menyimpan…' : status === 'confirmed' ? 'Simpan order' : 'Simpan draft'}
            </button>
            <button type="button" onClick={reset} className="min-h-12 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">
              Kosongkan
            </button>
          </div>
          <p className="text-xs text-ink-500">Satu order memakai satu voucher. Bila voucher sudah dipakai admin lain lebih dulu, database menolak dan Anda diminta memilih voucher lain.</p>
        </Step>
      </fieldset>

      <aside className="flex flex-col gap-2 rounded-2xl bg-navy-900 p-5 text-sm text-white lg:sticky lg:top-6">
        <h2 className="font-display text-base font-semibold">Perhitungan otomatis</h2>
        <span className="text-xs text-[#c5cbd9]">{voucher ? `${voucher.code} · ${ruleLabel(rule)}` : 'Belum memilih voucher'}</span>
        {reasons.length > 0 && (
          <span className="rounded-lg bg-warning-100 px-2.5 py-1.5 text-xs font-semibold text-warning-700">Order ditandai: perlu tinjau owner ({reasons.join('; ')})</span>
        )}
        {[
          ['Harga asli menu', rp(menu)],
          ['Potongan voucher', pv.discount !== null ? `− ${rp(pv.discount)}` : '—'],
          ['Bayar ke merchant', rp(after)],
          ['Omzet (harga jual)', rp(sell)],
          ['Modal dialokasikan', voucher ? (costUnknown ? 'Belum diisi (Rp0)' : rp(cost)) : '—'],
          ['HPP = merchant + modal', hpp !== null ? `− ${rp(hpp)}` : '—'],
          ['Laba kotor', rp(gross)],
          ['Biaya tambahan', `− ${rp(extra ?? 0)}`],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-navy-700 py-1.5">
            <span className="text-[#c5cbd9]">{k}</span>
            <span className="font-semibold">{v}</span>
          </div>
        ))}
        <div className="flex justify-between gap-2 pt-1">
          <span className="font-semibold">Laba bersih order</span>
          <span className={`font-display text-xl font-bold ${net !== null && net < 0 ? 'text-[#ffb4a8]' : 'text-orange-500'}`}>{rp(net)}</span>
        </div>
        <span className="text-xs text-[#8790a6]">Pratinjau. Server menghitung ulang dan menyimpan snapshot harga kredit, versi aturan voucher, dan modal saat order disimpan.</span>
      </aside>
    </form>
  )
}
