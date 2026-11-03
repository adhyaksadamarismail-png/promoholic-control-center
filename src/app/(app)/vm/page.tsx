import Link from 'next/link'
import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { getViewer } from '@/lib/auth'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { Card, Note, PageHeader, Pill, Stat, Tabs, inputCls, labelCls } from '@/components/ui'
import { BulkRestock } from '@/components/bulk-restock'
import { BatchHistory } from '@/components/batch-history'
import { dateLabel, jktDate } from '@/lib/format'
import { VOUCHER_STATUS, currentVersion, ruleLabel, type Rule, type VoucherStatus } from '@/lib/inventory'
import { addDevice, vmAddAccount, vmUpdateAccount } from './actions'

export const dynamic = 'force-dynamic'

const CHIP: Record<VoucherStatus, string> = {
  available: 'bg-success-100 text-success-700',
  used: 'bg-[#eef0f4] text-[#6e7689] line-through',
  reserved: 'bg-warning-100 text-warning-700',
  expired: 'bg-danger-100 text-danger-700',
  broken: 'bg-danger-100 text-danger-700',
}

export default async function VmPage({ searchParams }: { searchParams: Promise<{ device?: string; tab?: string }> }) {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  const { supabase } = viewer

  if (!viewer.isOwner) {
    // Catat percobaan akses staf. Data VM sendiri tetap tertutup RLS dan fungsi database.
    await createAdminClient().from('audit_log').insert({ actor_id: viewer.userId, action: 'vm.access_denied', entity: 'vm', entity_id: null, after: { path: '/vm' } })
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <PageHeader eyebrow="Khusus owner" title="Virtual Machine" />
        <Card title="Modul Virtual Machine khusus owner">
          <p className="text-sm">
            Staf tidak dapat melihat, menambah, atau mengubah akun lewat VM. Untuk restock, gunakan Panel Admin. Percobaan akses ini dicatat di audit log.
          </p>
          <Link href="/panel" className="flex min-h-11 w-fit items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white">Buka Panel Admin</Link>
        </Card>
      </div>
    )
  }

  // Brand VM yang belum punya modal berlaku: akun baru VM ditolak server sampai owner mengaturnya.
  const nowIso = new Date().toISOString()
  const [{ data: vmBrands }, { data: vmCosts }, { data: vmTypes }] = await Promise.all([
    supabase.from('brands').select('id, name').eq('vm_allowed', true).order('id'),
    supabase.from('brand_costs').select('brand_id').lte('effective_from', nowIso),
    supabase.from('voucher_types').select('brand_id, code, name, grp, auto_per_account, brands!inner(vm_allowed)').eq('brands.vm_allowed', true).eq('is_active', true).order('sort_order'),
  ])
  const costMissing = (vmBrands ?? []).filter((b) => !(vmCosts ?? []).some((c) => c.brand_id === b.id))
  const costNote = costMissing.length > 0 && (
    <div role="status" className="flex flex-col gap-2 rounded-lg bg-warning-100 px-3 py-2.5 text-sm text-warning-700 sm:flex-row sm:items-center sm:justify-between">
      <span>Modal brand {costMissing.map((b) => b.name).join(', ')} belum dikonfigurasi, jadi akun baru VM belum bisa disimpan.</span>
      <Link href={`/finance/brand-costs?brand=${costMissing[0].id}#brand-${costMissing[0].id}`} className="flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-navy-900 px-4 font-semibold text-white">
        Konfigurasi modal brand
      </Link>
    </div>
  )

  const tabs = (active: string) => (
    <Tabs
      items={[
        { key: 'devices', label: 'Device & akun', href: '/vm' },
        { key: 'bulk', label: 'Bulk Restock', href: '/vm?tab=bulk' },
      ]}
      active={active}
    />
  )
  if ((await searchParams).tab === 'bulk')
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <PageHeader eyebrow="Khusus owner · input banyak akun sekaligus" title="Virtual Machine" />
        {tabs('bulk')}
        <BulkRestock source="vm" brands={vmBrands ?? []} costMissing={costMissing.map((b) => b.id)} isOwner autoTypes={vmTypes ?? []} />
        <BatchHistory source="vm" />
      </div>
    )

  const [{ data: devices }, { data: accounts }, { data: vouchers }, { data: types }, { data: versions }] = await Promise.all([
    supabase.from('vm_devices').select('id, name, note, is_active').order('id'),
    supabase.from('accounts').select('id, brand_id, account_code, vm_device_id, account_number, entered_at, active_until').eq('source', 'vm').order('account_code'),
    supabase.from('vouchers').select('id, account_id, voucher_type_id, grp, slot, status, code'),
    supabase.from('voucher_types').select('id, brand_id, code, name, grp, auto_per_account, sort_order').eq('brand_id', 'KK').order('sort_order'),
    supabase.from('voucher_type_versions').select('voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, b1g1_terms, effective_from'),
  ])
  const sp = await searchParams
  const devs = devices ?? []
  const device = devs.find((d) => d.id === sp.device) ?? devs[0]
  const vmAccounts = accounts ?? []
  const vmIds = new Set(vmAccounts.map((a) => a.id))
  const vmVouchers = (vouchers ?? []).filter((v) => vmIds.has(v.account_id))
  const inDevice = vmAccounts.filter((a) => a.vm_device_id === device?.id)
  const typeOf = (id: string) => types?.find((t) => t.id === id)
  const vers = (versions ?? []) as (Rule & { voucher_type_id: string; effective_from: string })[]
  const today = jktDate()

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow='Akun Kopi Kenangan per virtual device · sumber restock "Virtual Machine"' title="Virtual Machine">
        <Pill tone="orange">Khusus owner</Pill>
      </PageHeader>
      {tabs('devices')}
      <Note>
        Data diisi manual oleh owner. Sistem tidak membaca voucher dari aplikasi Kopi Kenangan atau dari device; status voucher berubah hanya lewat
        transaksi dan koreksi yang tercatat.
      </Note>

      <div className="flex flex-wrap gap-3">
        <Stat label="Device aktif" value={devs.filter((d) => d.is_active).length} />
        <Stat label="Akun VM" value={vmAccounts.length} />
        <Stat label="Voucher utama tersedia" value={vmVouchers.filter((v) => v.grp === 'main' && v.status === 'available').length} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card title="Virtual device">
          <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
            {devs.map((d) => (
              <li key={d.id} className="min-w-[150px] shrink-0 lg:min-w-0">
                <Link
                  href={`/vm?device=${d.id}`}
                  aria-current={d.id === device?.id ? 'page' : undefined}
                  className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm ${d.id === device?.id ? 'bg-navy-900 text-white' : 'border border-cream-300 hover:bg-cream-100'}`}
                >
                  <span className="flex flex-col">
                    <b>{d.name}</b>
                    <span className={`font-mono text-xs ${d.id === device?.id ? 'text-[#c5cbd9]' : 'text-ink-500'}`}>{d.id}</span>
                  </span>
                  <span className="text-xs">{vmAccounts.filter((a) => a.vm_device_id === d.id).length} akun</span>
                </Link>
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-orange-700">+ Tambah device</summary>
            <ActionForm action={addDevice} className="mt-2 flex flex-col gap-2">
              <input name="name" required placeholder="Nama, mis. Device 5" className={inputCls} />
              <input name="note" placeholder="Catatan (opsional)" className={inputCls} />
              <SubmitButton variant="ghost">Simpan device</SubmitButton>
            </ActionForm>
          </details>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {device && (
            <Card title={`Akun di ${device.name}`} aside={<span className="font-mono text-sm text-ink-500">{device.id}</span>}>
              {!inDevice.length && <p className="text-sm text-ink-500">Belum ada akun di device ini.</p>}
              <ul className="flex flex-col gap-2">
                {inDevice.map((a) => {
                  const vs = vmVouchers.filter((v) => v.account_id === a.id).sort((x, y) => (typeOf(x.voucher_type_id)?.sort_order ?? 0) - (typeOf(y.voucher_type_id)?.sort_order ?? 0) || x.slot - y.slot)
                  const main = vs.filter((v) => v.grp === 'main')
                  const bp = vs.filter((v) => v.grp === 'extra')
                  const expired = a.active_until && a.active_until < today
                  return (
                    <li key={a.id} className="flex flex-col gap-2 rounded-xl border border-cream-300 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <Link href={`/accounts/${a.id}`} className="font-mono font-semibold">{a.account_code}</Link>
                          <span className="font-mono text-sm text-ink-500">{a.account_number}</span>
                          {a.active_until && <span className={`text-xs ${expired ? 'font-semibold text-danger-700' : 'text-ink-500'}`}>aktif s/d {dateLabel(a.active_until)}</span>}
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {main.map((v) => (
                            <span key={v.id} title={`${v.code} · ${VOUCHER_STATUS[v.status as VoucherStatus].label}`} className={`rounded px-1.5 text-xs font-bold ${CHIP[v.status as VoucherStatus]}`}>
                              {typeOf(v.voucher_type_id)?.code}
                            </span>
                          ))}
                          {bp.length > 0 && <span className="rounded bg-orange-100 px-1.5 text-xs font-bold text-orange-700">+{bp.filter((v) => v.status === 'available').length}/{bp.length} BP</span>}
                        </span>
                      </div>
                      <details className="text-sm">
                        <summary className="cursor-pointer text-xs font-semibold text-orange-700">Ubah data akun</summary>
                        <div className="mt-2 grid gap-3 md:max-w-md">
                          <ActionForm action={vmUpdateAccount} className="flex flex-col gap-2">
                            <input type="hidden" name="account" value={a.id} />
                            <input type="hidden" name="from_device" value={a.vm_device_id ?? ''} />
                            <label className={labelCls}>Nomor akun<input name="number" defaultValue={a.account_number ?? ''} required className={inputCls} /></label>
                            <label className={labelCls}>
                              Device
                              <select name="device" defaultValue={a.vm_device_id ?? ''} className={inputCls}>
                                {devs.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.id} · {d.name}</option>)}
                              </select>
                            </label>
                            <label className={labelCls}>Masa aktif<input type="date" name="active_until" defaultValue={a.active_until ?? ''} className={inputCls} /></label>
                            <SubmitButton variant="ghost">Simpan perubahan</SubmitButton>
                          </ActionForm>
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {device && (
            <Card title={`Tambah akun ke ${device.name}`}>
              {costNote}
              <ActionForm action={vmAddAccount} className="grid grid-cols-1 gap-3 sm:grid-cols-2" resultClassName="sm:col-span-2">
                <input type="hidden" name="device" value={device.id} />
                <input type="hidden" name="idem" value={randomUUID()} />
                <label className={labelCls}>ID akun<input name="code" required minLength={3} maxLength={32} placeholder="mis. 195678" className={`${inputCls} font-mono uppercase`} autoComplete="off" /></label>
                <label className={labelCls}>Nomor akun<input name="number" required inputMode="tel" placeholder="0857-xxxx-xxxx" className={inputCls} autoComplete="off" /></label>
                <label className={labelCls}>Masa aktif (opsional)<input type="date" name="active_until" className={inputCls} /></label>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-sm font-semibold">Voucher utama · dibuat otomatis</span>
                  <div className="flex flex-wrap gap-2">
                    {(types ?? []).filter((t) => t.auto_per_account).map((t) => (
                      <span key={t.id} className="rounded-lg bg-cream-100 px-3 py-1.5 text-xs"><b>{t.code}</b> · {ruleLabel(currentVersion(vers, t.id))}</span>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2"><SubmitButton variant="accent">Simpan akun ke {device.name}</SubmitButton></div>
              </ActionForm>
              <p className="text-xs text-ink-500">Email tidak diperlukan untuk akun VM. ID akun boleh 195678 atau KK-195678 (dianggap sama); ID dan nomor akun unik, server menolak duplikat. Tanggal masuk dicatat otomatis.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
