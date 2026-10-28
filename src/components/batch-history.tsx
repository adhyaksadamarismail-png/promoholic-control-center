import { createSessionClient } from '@/lib/supabase/server'
import { Card, Pill, Table } from '@/components/ui'
import { jktDateTime, rupiah } from '@/lib/format'

const MODE: Record<string, string> = { new_account: 'Akun baru', add_stock: 'Tambah voucher', extra_only: 'Baperan saja' }

/** Riwayat batch bulk restock (RLS: staf hanya batch Panel; owner semua). Detail per batch berisi akun & voucher. */
export async function BatchHistory({ source }: { source: 'panel' | 'vm' }) {
  const supabase = await createSessionClient()
  const [{ data: batches }, { data: profiles }] = await Promise.all([
    supabase
      .from('restock_batches')
      .select('id, code, source, mode, brand_id, row_count, new_accounts, voucher_count, total_cost, cost_unknown, status, source_note, created_by, created_at')
      .eq('source', source)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('profiles').select('id, full_name'),
  ])
  const ids = (batches ?? []).map((b) => b.id)
  const [{ data: restocks }, { data: accounts }] = await Promise.all([
    supabase.from('restocks').select('batch_id, code, account_id, items').in('batch_id', ids),
    supabase.from('account_list').select('id, account_code, vm_device_id'),
  ])
  const acc = (id: string | null) => accounts?.find((a) => a.id === id)

  return (
    <Card title={`Riwayat bulk restock ${source === 'vm' ? 'Virtual Machine' : 'Panel Admin'}`}>
      <Table head={['ID batch', 'Waktu', 'Pengguna', 'Jenis', 'Akun baru', 'Voucher', 'Total modal', 'Status', 'Detail']} empty="Belum ada batch.">
        {(batches ?? []).map((b) => {
          const items = (restocks ?? []).filter((r) => r.batch_id === b.id)
          return (
            <tr key={b.id}>
              <td className="whitespace-nowrap font-mono text-[13px] font-semibold">{b.code}</td>
              <td className="whitespace-nowrap">{jktDateTime(b.created_at)}</td>
              <td>{profiles?.find((p) => p.id === b.created_by)?.full_name ?? '—'}</td>
              <td>{MODE[b.mode]}{b.brand_id ? ` · ${b.brand_id}` : ''}</td>
              <td>{b.new_accounts}</td>
              <td>{b.voucher_count}</td>
              <td className="whitespace-nowrap">
                {rupiah(b.total_cost)}
                {b.cost_unknown > 0 && <div className="text-xs text-warning-700">{b.cost_unknown} belum diisi</div>}
              </td>
              <td><Pill tone="success">Selesai</Pill></td>
              <td>
                <details className="text-sm">
                  <summary className="cursor-pointer font-semibold text-orange-700">{items.length} restock</summary>
                  <ul className="mt-1 flex min-w-56 flex-col gap-0.5 text-xs">
                    {items.map((r) => (
                      <li key={r.code}>
                        <span className="font-mono">{r.code}</span> · {acc(r.account_id)?.account_code ?? 'Tanpa akun'}
                        {acc(r.account_id)?.vm_device_id ? ` (${acc(r.account_id)?.vm_device_id})` : ''} ·{' '}
                        {(r.items as { type: string; qty: number }[]).map((i) => `${i.type}×${i.qty}`).join(', ')}
                      </li>
                    ))}
                  </ul>
                  {b.source_note && <p className="mt-1 text-xs text-ink-500">Sumber: {b.source_note}</p>}
                </details>
              </td>
            </tr>
          )
        })}
      </Table>
      <p className="text-xs text-ink-500">Riwayat batch tidak dihapus walaupun akun atau vouchernya kemudian dipakai.</p>
    </Card>
  )
}
