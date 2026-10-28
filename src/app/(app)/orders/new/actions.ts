'use server'

import { z } from 'zod'
import { callRpc, int, str, type ActionResult } from '@/lib/rpc'

const PATHS = ['/orders/new', '/accounts', '/']
const uuid = z.string().uuid()

// Admin pencatat diambil dari sesi di database. Harga, potongan, HPP, dan laba dihitung ulang di record_order.
export async function createOrder(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const voucher = uuid.safeParse(str(fd, 'voucher'))
  const idem = uuid.safeParse(str(fd, 'idem'))
  if (!voucher.success) return { ok: false, message: 'Pilih voucher terlebih dahulu.' }
  if (!idem.success) return { ok: false, message: 'Muat ulang halaman lalu coba lagi.' }
  const name = str(fd, 'customer_name')
  const wa = str(fd, 'customer_wa')
  const menu = int(fd, 'menu_price')
  const sell = int(fd, 'sell_price')
  if (!name) return { ok: false, message: 'Nama customer wajib diisi.' }
  if (!/^(\+62|62|0)8[0-9]{8,11}$/.test(wa.replace(/[\s-]/g, ''))) return { ok: false, message: 'Nomor WhatsApp tidak valid. Contoh: 0812-3456-7890.' }
  if (!menu || menu <= 0) return { ok: false, message: 'Isi harga asli menu.' }
  if (sell === null || sell < 0) return { ok: false, message: 'Isi harga jual Promo.Holic.' }
  const confirm = str(fd, 'status') !== 'draft'

  const r = await callRpc('record_order', {
    p_voucher: voucher.data,
    p_customer_name: name,
    p_customer_wa: wa,
    p_ref: str(fd, 'ref') || null,
    p_menu_price: menu,
    p_sell_price: sell,
    p_extra_cost: int(fd, 'extra_cost') ?? 0,
    p_manual_discount: int(fd, 'manual_discount'),
    p_price_after_override: int(fd, 'price_after_override'),
    p_confirm: confirm,
    p_idem: idem.data,
  }, '', PATHS)
  if (!r.ok) return r
  return { ok: true, message: confirm ? `Order ${r.data} tersimpan. Voucher ditandai terpakai.` : `Draft ${r.data} tersimpan. Voucher dipesan sampai draft dikonfirmasi atau dibatalkan.`, data: r.data }
}

export async function confirmDraft(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'order'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  return callRpc('confirm_draft', { p_order: id.data }, 'Draft dikonfirmasi. Voucher terpakai.', PATHS)
}

export async function cancelDraft(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'order'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  return callRpc('cancel_draft', { p_order: id.data }, 'Draft dibatalkan. Voucher kembali tersedia.', PATHS)
}

export async function requestCancel(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = uuid.safeParse(str(fd, 'order'))
  const reason = str(fd, 'reason')
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  if (reason.length < 3) return { ok: false, message: 'Tulis alasan pembatalan.' }
  return callRpc('request_order_cancel', { p_order: id.data, p_reason: reason }, 'Pengajuan batal terkirim ke owner. Voucher tetap terpakai sampai disetujui.', [...PATHS, '/approvals'])
}
