import Link from 'next/link'
import { requireOwnerPage } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Table, Tabs, inputCls, labelCls } from '@/components/ui'
import { addDays, jktDate, jktDateTime, rupiah } from '@/lib/format'
import { currentVersion } from '@/lib/inventory'
import { addType, addVersion, setTypeAuto, updateType } from './actions'

export const dynamic = 'force-dynamic'

type Version = {
  id: string
  voucher_type_id: string
  discount_pct: number | null
  fixed_discount: number | null
  min_purchase: number | null
  max_discount: number | null
  b1g1_terms: string | null
  validity_note: string | null
  effective_from: string
  created_by: string | null
}
const BASIS: Record<string, string> = { credit_per_account: 'kredit per akun', rp_per_voucher: 'rupiah per voucher', free: 'gratis' }
const NA = <span className="font-semibold text-warning-700">belum dikonfigurasi</span>

/** Lengkap = potongan diketahui, dan bila berupa persen, batas maksimumnya juga diketahui. */
const configured = (v?: Version) => !!v && (v.fixed_discount !== null || (v.discount_pct !== null && v.max_discount !== null))
const discountText = (v?: Version) =>
  !v ? NA : v.fixed_discount !== null ? `Potongan ${rupiah(v.fixed_discount)}` : v.discount_pct !== null ? `${Number(v.discount_pct)}%` : v.b1g1_terms ? `B1G1: ${v.b1g1_terms}` : NA

export default async function VoucherConfigPage({ searchParams }: { searchParams: Promise<{ brand?: string; type?: string }> }) {
  const supabase = await requireOwnerPage()
  const sp = await searchParams
  const nowIso = new Date().toISOString()
  const [{ data: brands }, { data: types }, { data: versionsData }, { data: costs }, { data: profiles }] = await Promise.all([
    supabase.from('brands').select('id, name, reference_price, vm_allowed').order('name'),
    supabase.from('voucher_types').select('id, brand_id, code, name, grp, auto_per_account, sort_order, is_active').order('sort_order'),
    supabase.from('voucher_type_versions').select('*').order('effective_from', { ascending: false }),
    supabase.from('brand_costs').select('brand_id, basis, credits_per_account, rp_per_voucher, effective_from').lte('effective_from', nowIso).order('effective_from', { ascending: false }),
    supabase.from('profiles').select('id, full_name'),
  ])
  const versions = (versionsData ?? []) as Version[]
  const brand = (brands ?? []).find((b) => b.id === sp.brand) ?? brands?.[0]
  if (!brand) return null
  const bTypes = (types ?? []).filter((t) => t.brand_id === brand.id)
  const cur = (id: string) => currentVersion(versions, id)
  const unconfigured = bTypes.filter((t) => t.is_active && !configured(cur(t.id)))
  const sel = bTypes.find((t) => t.id === sp.type) ?? unconfigured[0] ?? bTypes[0]
  const selVer = sel ? cur(sel.id) : undefined
  const cost = costs?.find((c) => c.brand_id === brand.id)
  const history = versions.filter((v) => bTypes.some((t) => t.id === v.voucher_type_id))
  const tomorrow = addDays(jktDate(), 1)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Hanya owner · setiap perubahan = versi baru dengan tanggal berlaku" title="Konfigurasi Voucher per Brand" />
      <Note>Nilai yang belum dikonfirmasi ditandai &quot;belum dikonfigurasi&quot; dan tidak diisi angka perkiraan.</Note>

      <Tabs
        items={(brands ?? []).map((b) => {
          const n = (types ?? []).filter((t) => t.brand_id === b.id && t.is_active && !configured(cur(t.id))).length
          return { key: b.id, label: `${b.name}${n ? ` · ${n} belum` : ''}`, href: `/settings/vouchers?brand=${b.id}` }
        })}
        active={brand.id}
      />

      <dl className="grid grid-cols-2 gap-3 rounded-2xl border border-cream-300 bg-white p-4 md:grid-cols-4">
        {[
          ['Jalur restock', brand.vm_allowed ? 'Virtual Machine & Panel' : 'Panel Admin'],
          ['Dasar modal', cost ? BASIS[cost.basis] : 'belum dikonfigurasi'],
          ['Nilai modal', cost?.basis === 'credit_per_account' ? `${Number(cost.credits_per_account)} kredit / akun` : cost?.basis === 'rp_per_voucher' ? `${rupiah(cost.rp_per_voucher)} / voucher` : cost ? 'Rp0' : '—'],
          ['Harga acuan', brand.reference_price ? rupiah(brand.reference_price) : '—'],
        ].map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="text-xs font-bold uppercase tracking-[0.06em] text-ink-500">{k}</dt>
            <dd className="text-sm font-semibold">{v}</dd>
          </div>
        ))}
      </dl>

      {unconfigured.length > 0 && (
        <Note tone="warning">
          {unconfigured.length} jenis voucher {brand.name} belum dikonfigurasi lengkap. Akun tetap bisa direstock; potongan di form order diisi manual
          (atau batas maksimum belum diterapkan) dan order ditandai untuk ditinjau owner sampai ketentuannya diisi di sini.
        </Note>
      )}

      <Card title="Jenis voucher">
        <Table head={['Jenis voucher', 'Kelompok', 'Jumlah per akun', 'Diskon / potongan', 'Min. pembelian', 'Maks. potongan', 'Masa berlaku', 'Status', 'Berlaku sejak', '']}>
          {bTypes.map((t) => {
            const v = cur(t.id)
            const upcoming = versions.find((x) => x.voucher_type_id === t.id && x.effective_from > nowIso)
            return (
              <tr key={t.id} className={sel?.id === t.id ? 'bg-orange-100/50' : ''}>
                <td>
                  <span className="font-semibold">{t.name}</span> <span className="font-mono text-xs text-ink-500">{t.code}</span>
                  {!t.is_active && <div><Pill tone="neutral">Nonaktif</Pill></div>}
                </td>
                <td>{t.grp === 'main' ? 'Utama' : 'Tambahan'}</td>
                <td>{t.auto_per_account ? `${t.auto_per_account} otomatis` : 'diisi saat restock'}</td>
                <td>{discountText(v)}</td>
                <td>{!v ? NA : v.min_purchase ? rupiah(v.min_purchase) : 'tanpa minimum'}</td>
                <td>{!v || v.fixed_discount !== null ? (v ? '—' : NA) : v.max_discount !== null ? rupiah(v.max_discount) : NA}</td>
                <td className="text-ink-500">{v?.validity_note ?? '—'}</td>
                <td>
                  <Pill tone={configured(v) ? 'success' : 'warning'}>{configured(v) ? 'Lengkap' : 'Belum dikonfigurasi'}</Pill>
                  {upcoming && <div className="mt-1 text-xs text-ink-500">Versi baru {jktDateTime(upcoming.effective_from)}</div>}
                </td>
                <td className="whitespace-nowrap">{v ? jktDateTime(v.effective_from) : '—'}</td>
                <td><Link href={`/settings/vouchers?brand=${brand.id}&type=${t.id}`} className="font-semibold text-orange-700">Ubah</Link></td>
              </tr>
            )
          })}
        </Table>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {sel && (
          <Card title={`Ubah ketentuan: ${sel.name}`}>
            <ActionForm key={sel.id} action={addVersion} className="grid grid-cols-1 gap-3 sm:grid-cols-2" resultClassName="sm:col-span-2">
              <input type="hidden" name="type" value={sel.id} />
              <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
                <legend className="mb-1.5 text-sm font-semibold">Jenis potongan</legend>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['pct', 'Diskon persen'],
                    ['fixed', 'Potongan tetap (Rp)'],
                    ['none', 'Belum diketahui / B1G1'],
                  ].map(([k, l]) => (
                    <label key={k} className="flex min-h-11 items-center gap-2 rounded-lg border border-[#dcd2bf] px-3 text-sm">
                      <input
                        type="radio"
                        name="mode"
                        value={k}
                        defaultChecked={k === (selVer?.fixed_discount !== null && selVer ? 'fixed' : selVer?.discount_pct != null ? 'pct' : 'none')}
                      />
                      {l}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className={labelCls}>Diskon (%)<input name="discount_pct" inputMode="decimal" defaultValue={selVer?.discount_pct ?? ''} placeholder="kosong = belum dikonfigurasi" className={inputCls} /></label>
              <label className={labelCls}>Potongan tetap (Rp)<input name="fixed_discount" inputMode="numeric" defaultValue={selVer?.fixed_discount ?? ''} placeholder="kosong = belum dikonfigurasi" className={inputCls} /></label>
              <label className={labelCls}>Min. pembelian (Rp)<input name="min_purchase" inputMode="numeric" defaultValue={selVer?.min_purchase ?? ''} placeholder="kosong = tanpa minimum" className={inputCls} /></label>
              <label className={labelCls}>Maks. potongan (Rp, untuk diskon %)<input name="max_discount" inputMode="numeric" defaultValue={selVer?.max_discount ?? ''} placeholder="kosong = belum dikonfigurasi" className={inputCls} /></label>
              <label className={labelCls}>Ketentuan B1G1 (opsional)<input name="b1g1_terms" defaultValue={selVer?.b1g1_terms ?? ''} className={inputCls} /></label>
              <label className={labelCls}>Masa berlaku voucher (opsional)<input name="validity_note" defaultValue={selVer?.validity_note ?? ''} placeholder="mis. 7 hari sejak akun dibuat" className={inputCls} /></label>
              <label className={labelCls}>Berlaku mulai<input type="date" name="from" required defaultValue={tomorrow} className={inputCls} /></label>
              <div className="flex items-end"><SubmitButton variant="accent">Simpan sebagai versi baru</SubmitButton></div>
            </ActionForm>
            <p className="text-xs text-ink-500">
              Kolom kosong tetap &quot;belum dikonfigurasi&quot;. Order sebelum tanggal berlaku tetap memakai versi lama yang tersimpan di order.
              Diskon persen tanpa batas maksimum membuat order ditandai untuk ditinjau.
            </p>
            {sel.grp === 'main' && (
              <details className="text-sm">
                <summary className="cursor-pointer font-semibold text-orange-700">Jumlah otomatis per akun baru</summary>
                <ActionForm key={`a-${sel.id}-${sel.auto_per_account}`} action={setTypeAuto} className="mt-2 flex flex-col gap-2"
                  confirm="Ubah jumlah voucher otomatis untuk akun baru berikutnya?">
                  <input type="hidden" name="type" value={sel.id} />
                  <label className={labelCls}>
                    Jumlah per akun baru
                    <input name="auto_per_account" inputMode="numeric" defaultValue={sel.auto_per_account ?? ''} placeholder="kosong = diisi saat restock" className={inputCls} />
                    <span className="text-xs font-normal text-ink-500">Berlaku untuk akun yang dibuat setelah disimpan; akun lama tidak berubah. Tercatat di audit log.</span>
                  </label>
                  <SubmitButton variant="ghost">Simpan jumlah</SubmitButton>
                </ActionForm>
              </details>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-orange-700">Ganti nama / nonaktifkan jenis</summary>
              <ActionForm key={`u-${sel.id}`} action={updateType} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="type" value={sel.id} />
                <label className={labelCls}>Nama<input name="name" defaultValue={sel.name} required className={inputCls} /></label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={sel.is_active} /> Aktif (dipakai untuk restock baru)</label>
                <SubmitButton variant="ghost">Simpan</SubmitButton>
              </ActionForm>
            </details>
          </Card>
        )}

        <Card title={`Histori perubahan · ${brand.name}`}>
          <ul className="flex flex-col divide-y divide-[#f1eadc] text-sm">
            {history.map((v) => {
              const t = bTypes.find((x) => x.id === v.voucher_type_id)
              const isCurrent = cur(v.voucher_type_id)?.id === v.id
              return (
                <li key={v.id} className="flex flex-col gap-0.5 py-2">
                  <span>
                    <b>{t?.name}</b> · {discountText(v)}
                    {v.min_purchase ? ` · min. ${rupiah(v.min_purchase)}` : ''}
                    {v.max_discount !== null ? ` · maks. ${rupiah(v.max_discount)}` : ''}
                  </span>
                  <span className="text-xs text-ink-500">
                    Berlaku {jktDateTime(v.effective_from)} · {profiles?.find((p) => p.id === v.created_by)?.full_name ?? 'Sistem'}
                    {isCurrent && ' · aktif'}
                    {v.effective_from > nowIso && ' · terjadwal'}
                  </span>
                </li>
              )
            })}
            {!history.length && <li className="py-2 text-ink-500">Belum ada versi.</li>}
          </ul>
        </Card>
      </div>

      <Card title="+ Tambah jenis voucher">
        <ActionForm action={addType} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" resultClassName="sm:col-span-2 lg:col-span-5">
          <input type="hidden" name="brand" value={brand.id} />
          <label className={labelCls}>Kode<input name="code" required pattern="[A-Za-z0-9]{1,8}" placeholder="mis. D30" className={`${inputCls} font-mono uppercase`} /></label>
          <label className={labelCls}>Nama<input name="name" required className={inputCls} /></label>
          <label className={labelCls}>
            Kelompok
            <select name="grp" className={inputCls}>
              <option value="main">Utama</option>
              <option value="extra">Tambahan</option>
            </select>
          </label>
          <label className={labelCls}>Otomatis per akun<input name="auto_per_account" inputMode="numeric" placeholder="kosong = diisi saat restock" className={inputCls} /></label>
          <div className="flex items-end"><SubmitButton variant="ghost">Tambah jenis</SubmitButton></div>
        </ActionForm>
        <p className="text-xs text-ink-500">Jenis baru dimulai tanpa ketentuan (&quot;belum dikonfigurasi&quot;). Kode dipakai di ID voucher dan tidak bisa diubah.</p>
      </Card>
    </div>
  )
}
