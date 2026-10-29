'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
import { createSessionClient } from '@/lib/supabase/server'
import { normalizeAccountCode } from '@/lib/inventory'
import { createOrder, requestCancel } from '../../orders/new/actions'

export async function requestStockAdjust(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const voucher = z.string().uuid().safeParse(str(fd, 'voucher'))
  const status = z.enum(['available', 'expired', 'broken']).safeParse(str(fd, 'new_status'))
  const reason = str(fd, 'reason')
  if (!voucher.success || !status.success) return { ok: false, message: 'Pilih status baru.' }
  if (reason.length < 3) return { ok: false, message: 'Tulis alasan koreksi.' }
  return callRpc('request_stock_adjust', { p_voucher: voucher.data, p_new_status: status.data, p_reason: reason },
    'Pengajuan koreksi stok terkirim ke owner.', ['/accounts', '/approvals'])
}

const accountPath = (fd: FormData) => {
  const id = z.string().uuid().safeParse(str(fd, 'account'))
  return id.success ? `/accounts/${id.data}` : '/accounts'
}

/** Tandai dipakai = order terkonfirmasi lewat record_order (validasi, potongan, HPP & laba dihitung ulang server). */
export async function markVoucherUsed(prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await createOrder(prev, fd)
  if (r.ok) revalidatePath(accountPath(fd))
  return r
}

/** Owner: batalkan pemakaian langsung dengan alasan (cancel_order_now → jalur persetujuan yang sama, tercatat di audit). */
export async function cancelUseNow(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const order = z.string().uuid().safeParse(str(fd, 'order'))
  const reason = str(fd, 'reason')
  if (!order.success) return { ok: false, message: 'Permintaan tidak valid.' }
  if (reason.length < 3) return { ok: false, message: 'Tulis alasan pembatalan.' }
  const r = await callRpc('cancel_order_now', { p_order: order.data, p_reason: reason }, '', [accountPath(fd), '/orders/new', '/approvals', '/'])
  return r.ok ? { ok: true, message: `Pemakaian ${r.data} dibatalkan. Voucher kembali tersedia; histori tetap tercatat.` } : r
}

/** Staf: ajukan pembatalan ke owner (order yang ia catat sendiri). */
export async function requestUseCancel(prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await requestCancel(prev, fd)
  if (r.ok) revalidatePath(accountPath(fd))
  return r
}

type DeleteResult = { deleted: number; skipped: number; results: { id: string; code: string | null; ok: boolean; reason?: string; vouchers?: number }[] }

/** Owner: hapus satu akun setelah mengetik ID-nya. Aturan (transaksi, histori) & audit di delete_accounts. */
export async function deleteAccount(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = z.string().uuid().safeParse(str(fd, 'account'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const supabase = await createSessionClient()
  // Tabel akun hanya terbaca owner (RLS); staf berhenti di sini dan tetap ditolak require_owner di database.
  const { data: acc } = await supabase.from('accounts').select('account_code').eq('id', id.data).maybeSingle()
  if (!acc) return { ok: false, message: 'Akses ditolak: khusus owner.' }
  if (normalizeAccountCode(str(fd, 'confirm_code')) !== acc.account_code) return { ok: false, message: `Ketik ID akun ${acc.account_code} persis untuk konfirmasi.` }
  const r = await callRpc('delete_accounts', { p_accounts: [id.data] }, '', ['/accounts', '/stock', '/panel', '/vm'])
  if (!r.ok) return r
  const res = r.data as DeleteResult
  if (!res.deleted) return { ok: false, message: `Akun tidak dihapus: ${res.results[0]?.reason ?? 'ditolak'}` }
  redirect(`/accounts?deleted=${encodeURIComponent(acc.account_code)}`)
}
