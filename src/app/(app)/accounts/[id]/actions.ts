'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'
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

type ArchiveResult = { done: number; results: { reason?: string }[] }

/** Owner: arsipkan akun ini. Histori tidak berubah; aturan & audit di archive_accounts. */
export async function archiveAccount(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = z.string().uuid().safeParse(str(fd, 'account'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const r = await callRpc('archive_accounts', { p_accounts: [id.data], p_note: str(fd, 'note') || null }, '', ['/accounts', '/stock', '/panel', '/vm', '/orders/new', '/'])
  if (!r.ok) return r
  const res = r.data as ArchiveResult
  if (!res.done) return { ok: false, message: `Akun tidak diarsipkan: ${res.results[0]?.reason ?? 'ditolak'}` }
  redirect(`/accounts?archived=${encodeURIComponent(str(fd, 'code'))}`)
}

/** Owner: pulihkan akun ini dari arsip. */
export async function restoreAccount(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = z.string().uuid().safeParse(str(fd, 'account'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const r = await callRpc('restore_accounts', { p_accounts: [id.data] }, '', [`/accounts/${id.data}`, '/accounts', '/stock', '/panel', '/vm', '/orders/new', '/'])
  if (!r.ok) return r
  const res = r.data as ArchiveResult
  return res.done ? { ok: true, message: 'Akun dipulihkan. Voucher dan histori kembali apa adanya.' } : { ok: false, message: res.results[0]?.reason ?? 'Akun tidak dipulihkan.' }
}
