import Link from 'next/link'
import { requireOwnerPage } from '@/lib/auth'
import { Card, Note, PageHeader, Pill } from '@/components/ui'
import { jktDate, jktDateTime } from '@/lib/format'
import { BASIS_LABEL, brandCostStatus, costValue, type BrandCost } from '@/lib/brand-costs'
import { BrandCostForm } from './brand-cost-form'

export const dynamic = 'force-dynamic'

/** Keuangan → Modal per Brand (khusus owner). Setiap simpan = versi baru lewat set_brand_cost (validasi + audit). */
export default async function BrandCostsPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
  const supabase = await requireOwnerPage()
  const focus = (await searchParams).brand
  const nowIso = new Date().toISOString()
  const today = jktDate()
  const [{ data: brands }, { data: costs }, { data: credit }] = await Promise.all([
    supabase.from('brands').select('id, name, vm_allowed').order('name'),
    supabase.from('brand_costs').select('id, brand_id, basis, credits_per_account, rp_per_voucher, effective_from').order('effective_from', { ascending: false }),
    supabase.from('credit_prices').select('rp_per_credit').lte('effective_from', nowIso).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
  ])
  const rows = (costs ?? []) as BrandCost[]
  const creditPrice = credit?.rp_per_credit ?? null
  const missing = (brands ?? []).filter((b) => !brandCostStatus(rows, b.id, nowIso).active)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader eyebrow="Keuangan · hanya owner" title="Modal per Brand">
        <Link href="/finance" className="flex min-h-11 items-center rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Kembali ke Keuangan</Link>
      </PageHeader>
      <Note>
        Modal dipakai saat akun atau voucher baru masuk lewat restock. Setiap perubahan disimpan sebagai versi baru dengan tanggal mulai
        berlaku dan tercatat di audit log; versi lama dan order lama tidak diubah. Tidak ada nilai yang diisi otomatis.
      </Note>
      {missing.length > 0 && (
        <Note tone="warning">
          Belum dikonfigurasi: {missing.map((b) => b.name).join(', ')}. Akun baru untuk brand ini ditolak sampai modalnya diatur di bawah.
        </Note>
      )}
      {!creditPrice && <Note tone="warning">Harga kredit belum dikonfigurasi. Metode &quot;Kredit per akun&quot; memerlukannya: atur di Keuangan → Harga modal.</Note>}

      {(brands ?? []).map((b) => {
        const s = brandCostStatus(rows, b.id, nowIso)
        return (
          <section key={b.id} id={`brand-${b.id}`} className={`scroll-mt-6 ${focus === b.id ? 'rounded-2xl ring-2 ring-orange-500' : ''}`}>
            <Card
              title={`${b.name} (${b.id})`}
              aside={s.active ? <Pill tone="success">Aktif</Pill> : <Pill tone="warning">Belum dikonfigurasi</Pill>}
            >
              {s.active ? (
                <p className="text-sm">
                  <b>{BASIS_LABEL[s.active.basis]}</b> · {costValue(s.active, creditPrice)}
                  <span className="text-ink-500"> · berlaku sejak {jktDateTime(s.active.effective_from)}</span>
                </p>
              ) : (
                <p className="text-sm text-ink-500">Belum ada modal yang berlaku untuk brand ini.</p>
              )}

              {(s.scheduled.length > 0 || s.past.length > 0) && (
                <ul className="flex flex-col divide-y divide-[#f1eadc] text-sm">
                  {s.scheduled.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{BASIS_LABEL[c.basis]} · {costValue(c, creditPrice)} · mulai {jktDateTime(c.effective_from)}</span>
                      <Pill tone="info">Terjadwal</Pill>
                    </li>
                  ))}
                  {s.past.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-ink-500">
                      <span>{BASIS_LABEL[c.basis]} · {costValue(c, null)} · sejak {jktDateTime(c.effective_from)}</span>
                      <Pill>Tidak berlaku lagi</Pill>
                    </li>
                  ))}
                </ul>
              )}

              <details open={!s.active || focus === b.id} className="text-sm">
                <summary className="min-h-11 cursor-pointer content-center font-semibold text-orange-700">
                  {s.active ? 'Ubah modal (versi baru)' : 'Konfigurasi modal'}
                </summary>
                <div className="pt-2">
                  <BrandCostForm brand={b.id} brandName={b.name} today={today} creditPrice={creditPrice} />
                </div>
              </details>
            </Card>
          </section>
        )
      })}
    </div>
  )
}
