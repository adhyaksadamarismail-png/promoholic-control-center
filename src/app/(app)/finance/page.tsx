import Link from 'next/link'
import { requireOwnerPage } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Stat, Table, Tabs, inputCls, labelCls } from '@/components/ui'
import { addDays, dateLabel, isYmd, jktDate, jktDateTime, rupiah } from '@/lib/format'
import { loadFinance, periodLabel, shiftPeriod, type Period } from '@/lib/finance'
import { currentVersion, ruleLabel, type Rule } from '@/lib/inventory'
import { addExpense, addPurchase, scheduleCreditPrice, setAllocation } from './actions'

export const dynamic = 'force-dynamic'

const PERIODS: { key: Period; label: string }[] = [
  { key: 'day', label: 'Harian' },
  { key: 'week', label: 'Mingguan' },
  { key: 'month', label: 'Bulanan' },
]
const BASIS: Record<string, string> = { credit_per_account: 'Kredit per akun', rp_per_voucher: 'Rupiah per voucher', free: 'Gratis' }
const METHOD: Record<string, { name: string; desc: string }> = {
  equal_main: { name: 'Rata ke voucher utama', desc: 'Modal akun dibagi sama ke setiap voucher utama; voucher tambahan Rp0.' },
  weighted_max_discount: { name: 'Berbobot potongan maksimum', desc: 'Voucher dengan potongan maksimum lebih besar menanggung modal lebih besar.' },
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ p?: string; d?: string }> }) {
  const supabase = await requireOwnerPage()
  const sp = await searchParams
  const p: Period = PERIODS.some((x) => x.key === sp.p) ? (sp.p as Period) : 'week'
  const today = jktDate()
  const d = isYmd(sp.d) ? sp.d : today
  const nowIso = new Date().toISOString()

  const [fin, { data: credits }, { data: costs }, { data: alloc }, { data: brands }, { data: types }, { data: versions }] = await Promise.all([
    loadFinance(supabase, p, d),
    supabase.from('credit_prices').select('rp_per_credit, effective_from').order('effective_from', { ascending: false }),
    supabase.from('brand_costs').select('brand_id, basis, credits_per_account, rp_per_voucher, effective_from').lte('effective_from', nowIso).order('effective_from', { ascending: false }),
    supabase.from('cost_allocation_settings').select('method, extra_gets_cost, effective_from').order('effective_from', { ascending: false }),
    supabase.from('brands').select('id, name').order('name'),
    supabase.from('voucher_types').select('id, brand_id, code, name, sort_order').eq('is_active', true).order('sort_order'),
    supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
  ])
  const c = fin.current
  const creditNow = credits?.find((x) => x.effective_from <= nowIso)
  const creditPrev = credits?.filter((x) => x.effective_from <= nowIso)[1]
  const creditNext = credits?.filter((x) => x.effective_from > nowIso).at(-1)
  const allocNow = alloc?.find((x) => x.effective_from <= nowIso)
  const href = (pp: Period, dd: string) => `/finance?p=${pp}&d=${dd}`
  const maxAbs = Math.max(1, ...fin.buckets.map((b) => Math.abs(b.net)))
  const hasNeg = fin.buckets.some((b) => b.net < 0)
  const vers = (versions ?? []) as (Rule & { voucher_type_id: string; effective_from: string })[]

  const pnlRows: [string, number, 'plus' | 'minus' | 'total'][] = [
    ['Omzet (harga jual)', c.revenue, 'plus'],
    ['Bayar ke merchant', c.merchant, 'minus'],
    ['Modal voucher terpakai (HPP)', c.voucherCost, 'minus'],
    ['Laba kotor', c.gross, 'total'],
    ['Biaya tambahan order', c.extraCost, 'minus'],
    ['Beban voucher kedaluwarsa / rusak', c.expiredLoss, 'minus'],
    ['Uang saku & bonus disetujui', c.payroll, 'minus'],
    ['Biaya operasional', c.expenses, 'minus'],
    ['Laba bersih', c.net, 'total'],
  ]

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Hanya owner · dihitung dari transaksi tersimpan" title="Dashboard Keuangan">
        <a href={`/finance/export?p=${p}&d=${d}`} className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Export CSV order</a>
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs items={PERIODS.map((x) => ({ key: x.key, label: x.label, href: href(x.key, d) }))} active={p} />
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Link href={href(p, shiftPeriod(p, d, -1))} aria-label="Periode sebelumnya" className="flex size-11 items-center justify-center rounded-lg border border-[#dcd2bf] bg-white font-bold">←</Link>
          <span className="min-w-0 flex-1 text-center text-sm font-semibold sm:min-w-44 sm:flex-none">{periodLabel(p, d)}</span>
          <Link href={href(p, shiftPeriod(p, d, 1))} aria-label="Periode berikutnya" className="flex size-11 items-center justify-center rounded-lg border border-[#dcd2bf] bg-white font-bold">→</Link>
          <Link href={href(p, today)} className="flex min-h-11 items-center whitespace-nowrap px-2 text-sm font-semibold text-orange-700">Hari ini</Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Stat label="Omzet" value={rupiah(c.revenue)} sub={`${c.orders} order terkonfirmasi`} />
        <Stat label="HPP" value={rupiah(c.merchant + c.voucherCost)} sub="merchant + modal voucher" />
        <Stat label="Laba kotor" value={rupiah(c.gross)} sub={c.revenue ? `margin ${Math.round((c.gross / c.revenue) * 100)}%` : '—'} />
        <Stat label="Laba bersih" value={rupiah(c.net)} sub="setelah biaya, uang saku & bonus" />
        <Stat label="Perlu ditinjau" value={c.review} sub={c.review ? 'order dengan potongan manual / selisih' : 'tidak ada'} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title="Laba bersih per periode" aside={<span className="text-xs text-ink-500">{fin.buckets.length} periode terakhir · arahkan ke batang untuk rincian</span>}>
          <div className="flex h-56 items-stretch gap-1.5 border-b border-cream-300 pt-6" role="img" aria-label="Grafik laba bersih per periode; rincian ada di tabel di bawahnya">
            {fin.buckets.map((b) => {
              const h = (Math.abs(b.net) / maxAbs) * (hasNeg ? 50 : 100)
              return (
                <div key={b.start} className="group relative flex flex-1 flex-col justify-end" tabIndex={0}>
                  <div className={`flex flex-1 flex-col ${hasNeg ? 'justify-center' : 'justify-end'}`}>
                    <div className="flex flex-col justify-end" style={{ height: hasNeg ? '50%' : '100%' }}>
                      {b.net >= 0 && <div className="rounded-t bg-navy-700 group-hover:bg-orange-500 group-focus:bg-orange-500" style={{ height: `${hasNeg ? h * 2 : h}%`, minHeight: b.net ? 2 : 0 }} />}
                    </div>
                    {hasNeg && (
                      <div className="flex flex-col justify-start border-t border-ink-500/40" style={{ height: '50%' }}>
                        {b.net < 0 && <div className="rounded-b bg-danger-700/70" style={{ height: `${h * 2}%`, minHeight: 2 }} />}
                      </div>
                    )}
                  </div>
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 hidden w-44 -translate-x-1/2 flex-col gap-0.5 rounded-lg bg-navy-900 px-3 py-2 text-xs text-white shadow-lg group-hover:flex group-focus:flex">
                    <b>{b.label}</b>
                    <span>Omzet {rupiah(b.revenue)}</span>
                    <span>HPP {rupiah(b.merchant + b.voucherCost)}</span>
                    <span>Biaya {rupiah(b.extraCost + b.expiredLoss + b.payroll + b.expenses)}</span>
                    <span className="font-semibold">Laba bersih {rupiah(b.net)}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex gap-1.5">
            {fin.buckets.map((b, i, all) => (
              // Label selang-seling bila batang banyak; periode terakhir selalu berlabel.
              <span key={b.start} className="flex-1 whitespace-nowrap text-center text-[11px] text-ink-500">
                {all.length <= 8 || (all.length - 1 - i) % 2 === 0 ? b.label : ''}
              </span>
            ))}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-orange-700">Lihat sebagai tabel</summary>
            <Table head={['Periode', 'Order', 'Omzet', 'HPP', 'Biaya', 'Laba bersih']}>
              {fin.buckets.map((b) => (
                <tr key={b.start}>
                  <td>{b.label}</td>
                  <td>{b.orders}</td>
                  <td>{rupiah(b.revenue)}</td>
                  <td>{rupiah(b.merchant + b.voucherCost)}</td>
                  <td>{rupiah(b.extraCost + b.expiredLoss + b.payroll + b.expenses)}</td>
                  <td className="font-semibold">{rupiah(b.net)}</td>
                </tr>
              ))}
            </Table>
          </details>
        </Card>

        <Card title={`Laba rugi · ${periodLabel(p, d)}`}>
          <dl className="flex flex-col text-sm">
            {pnlRows.map(([k, v, kind]) => (
              <div key={k} className={`flex justify-between gap-3 py-2 ${kind === 'total' ? 'border-t border-navy-900 font-semibold' : 'border-b border-[#f1eadc]'}`}>
                <dt className={kind === 'minus' ? 'pl-3 text-ink-500' : ''}>{kind === 'minus' ? '− ' : ''}{k}</dt>
                <dd className={kind === 'total' ? 'font-display text-base' : ''}>{rupiah(v)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-ink-500">Order memakai snapshot saat dicatat; order yang dibatalkan resmi tidak dihitung. Uang saku & bonus dihitung dari shift yang disetujui pada periode ini.</p>
        </Card>
      </div>

      <Card title={`Alur persediaan akun & kredit · ${periodLabel(p, d)}`}>
        <p className="text-sm text-ink-500">Modal pembelian dicatat sebagai persediaan, lalu menjadi HPP hanya saat voucher terpakai.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ['Pembelian kredit / akun', fin.flow.purchased, 'dicatat manual di bawah'],
            ['Modal masuk ke voucher', fin.flow.inventoryIn, 'dari restock periode ini'],
            ['Menjadi HPP', fin.flow.used, 'voucher terpakai'],
            ['Beban kedaluwarsa / rusak', fin.flow.expired, 'bukan HPP'],
            ['Sisa persediaan saat ini', fin.flow.onHand, 'voucher tersedia + dipesan'],
          ].map(([l, v, n]) => (
            <div key={l as string} className="flex flex-col gap-0.5 rounded-xl bg-cream-100 p-3">
              <span className="text-xs font-bold uppercase tracking-[0.05em] text-ink-500">{l}</span>
              <span className="font-display text-lg font-bold">{rupiah(v as number)}</span>
              <span className="text-xs text-ink-500">{n}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card title="Biaya operasional">
          <ActionForm action={addExpense} className="grid grid-cols-1 gap-2 sm:grid-cols-2" resultClassName="sm:col-span-2">
            <label className={labelCls}>Tanggal<input type="date" name="date" defaultValue={today} required className={inputCls} /></label>
            <label className={labelCls}>Kategori<input name="category" required list="expense-cat" placeholder="mis. Internet" className={inputCls} /></label>
            <datalist id="expense-cat"><option value="Internet" /><option value="Pulsa & paket" /><option value="Perangkat" /><option value="Iklan" /><option value="Lain-lain" /></datalist>
            <label className={labelCls}>Nominal (Rp)<input name="amount" inputMode="numeric" required className={inputCls} /></label>
            <label className={labelCls}>Catatan<input name="note" className={inputCls} /></label>
            <div className="sm:col-span-2"><SubmitButton variant="accent">Catat biaya</SubmitButton></div>
          </ActionForm>
          <ul className="flex flex-col divide-y divide-[#f1eadc] text-sm">
            {fin.expenses.map((x) => (
              <li key={x.id} className="flex justify-between gap-2 py-2"><span>{dateLabel(x.spent_on)} · {x.category}{x.note ? ` · ${x.note}` : ''}</span><b>{rupiah(x.amount_rp)}</b></li>
            ))}
            {!fin.expenses.length && <li className="py-2 text-ink-500">Belum ada biaya pada periode ini.</li>}
          </ul>
        </Card>

        <Card title="Pembelian persediaan (kredit / akun)">
          <ActionForm action={addPurchase} className="grid grid-cols-1 gap-2 sm:grid-cols-2" resultClassName="sm:col-span-2">
            <label className={labelCls}>Tanggal<input type="date" name="date" defaultValue={today} required className={inputCls} /></label>
            <label className={labelCls}>Jumlah kredit (opsional)<input name="credits" inputMode="decimal" className={inputCls} /></label>
            <label className={labelCls}>Nominal (Rp)<input name="amount" inputMode="numeric" required className={inputCls} /></label>
            <label className={labelCls}>Catatan<input name="note" className={inputCls} /></label>
            <div className="sm:col-span-2"><SubmitButton variant="accent">Catat pembelian</SubmitButton></div>
          </ActionForm>
          <ul className="flex flex-col divide-y divide-[#f1eadc] text-sm">
            {fin.purchases.map((x) => (
              <li key={x.id} className="flex justify-between gap-2 py-2"><span>{dateLabel(x.purchased_on)}{x.credits ? ` · ${Number(x.credits)} kredit` : ''}{x.note ? ` · ${x.note}` : ''}</span><b>{rupiah(x.amount_rp)}</b></li>
            ))}
            {!fin.purchases.length && <li className="py-2 text-ink-500">Belum ada pembelian pada periode ini.</li>}
          </ul>
          <p className="text-xs text-ink-500">Pembelian masuk ke persediaan, bukan langsung ke laba rugi.</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card title="Harga modal">
          <p className="text-sm">
            1 kredit = <b>{creditNow ? rupiah(creditNow.rp_per_credit) : 'belum dikonfigurasi'}</b>
            {creditNow && ` sejak ${jktDateTime(creditNow.effective_from)}`}
            {creditPrev && ` (sebelumnya ${rupiah(creditPrev.rp_per_credit)})`}
          </p>
          {creditNext && <Note tone="warning">Terjadwal: {rupiah(creditNext.rp_per_credit)} mulai {jktDateTime(creditNext.effective_from)}.</Note>}
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-orange-700">Jadwalkan perubahan</summary>
            <ActionForm action={scheduleCreditPrice} className="mt-2 grid gap-2 sm:grid-cols-3">
              <label className={labelCls}>Rp per kredit<input name="price" inputMode="numeric" required className={inputCls} /></label>
              <label className={labelCls}>Berlaku mulai<input type="date" name="from" min={today} defaultValue={addDays(today, 1)} required className={inputCls} /></label>
              <div className="flex items-end"><SubmitButton variant="ghost">Simpan</SubmitButton></div>
            </ActionForm>
          </details>
          <Table head={['Brand', 'Dasar modal', 'Nilai', 'Berlaku sejak']}>
            {(brands ?? []).map((b) => {
              const bc = costs?.find((x) => x.brand_id === b.id)
              return (
                <tr key={b.id}>
                  <td className="font-semibold">{b.name}</td>
                  <td>{bc ? BASIS[bc.basis] : <Pill tone="warning">Belum dikonfigurasi</Pill>}</td>
                  <td>
                    {bc?.basis === 'credit_per_account' && `${Number(bc.credits_per_account)} kredit${creditNow ? ` = ${rupiah(Number(bc.credits_per_account) * creditNow.rp_per_credit)}` : ''}`}
                    {bc?.basis === 'rp_per_voucher' && `${rupiah(bc.rp_per_voucher)} / voucher`}
                    {bc?.basis === 'free' && 'Rp0'}
                  </td>
                  <td>{bc ? jktDateTime(bc.effective_from) : '—'}</td>
                </tr>
              )
            })}
          </Table>
          <p className="text-xs text-ink-500">Setiap order menyimpan salinan harga modal saat dicatat. Perubahan tidak menghitung ulang order lama.</p>
        </Card>

        <Card title="Metode alokasi modal per voucher">
          <p className="text-sm text-ink-500">Modal satu akun dihitung sekali, lalu dibagi ke voucher di akun itu. Perubahan berlaku untuk akun yang masuk setelah tanggal efektif.</p>
          {Object.entries(METHOD).map(([k, m]) => (
            <div key={k} className={`flex flex-col gap-0.5 rounded-xl border p-3 text-sm ${allocNow?.method === k ? 'border-orange-500 bg-orange-100' : 'border-cream-300'}`}>
              <span className="flex items-center gap-2 font-semibold">{m.name}{allocNow?.method === k && <Pill tone="orange">Aktif</Pill>}</span>
              <span className="text-ink-500">{m.desc}</span>
            </div>
          ))}
          <p className="text-xs text-ink-500">
            Voucher tambahan {allocNow?.extra_gets_cost ? 'ikut' : 'tidak ikut'} menanggung modal. Voucher yang kedaluwarsa dicatat sebagai beban kedaluwarsa, bukan HPP.
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-orange-700">Ubah metode</summary>
            <ActionForm action={setAllocation} className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className={labelCls}>
                Metode
                <select name="method" defaultValue={allocNow?.method} className={inputCls}>
                  {Object.entries(METHOD).map(([k, m]) => <option key={k} value={k}>{m.name}</option>)}
                </select>
              </label>
              <label className={labelCls}>Berlaku mulai<input type="date" name="from" min={today} defaultValue={addDays(today, 1)} required className={inputCls} /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="extra" /> Voucher tambahan ikut menanggung modal</label>
              <div><SubmitButton variant="ghost">Simpan versi</SubmitButton></div>
            </ActionForm>
          </details>
        </Card>
      </div>

      <Card title="Ketentuan voucher per brand" aside={<Link href="/settings/vouchers" className="text-sm font-semibold text-orange-700">Buka konfigurasi</Link>}>
        <Table head={['Brand', 'Jenis', 'Ketentuan berlaku', 'Status']}>
          {(types ?? []).map((t) => {
            const r = currentVersion(vers, t.id)
            const ok = !!r && (r.fixed_discount !== null || (r.discount_pct !== null && r.max_discount !== null))
            return (
              <tr key={t.id}>
                <td>{brands?.find((b) => b.id === t.brand_id)?.name}</td>
                <td className="font-semibold">{t.name}</td>
                <td className="text-ink-500">{ruleLabel(r)}</td>
                <td><Pill tone={ok ? 'success' : 'warning'}>{ok ? 'Lengkap' : 'Belum dikonfigurasi'}</Pill></td>
              </tr>
            )
          })}
        </Table>
      </Card>
    </div>
  )
}
