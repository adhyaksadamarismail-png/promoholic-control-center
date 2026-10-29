'use server'

import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'

export async function requestStockAdjust(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const voucher = z.string().uuid().safeParse(str(fd, 'voucher'))
  const status = z.enum(['available', 'expired', 'broken']).safeParse(str(fd, 'new_status'))
  const reason = str(fd, 'reason')
  if (!voucher.success || !status.success) return { ok: false, message: 'Pilih status baru.' }
  if (reason.length < 3) return { ok: false, message: 'Tulis alasan koreksi.' }
  return callRpc('request_stock_adjust', { p_voucher: voucher.data, p_new_status: status.data, p_reason: reason },
    'Pengajuan koreksi stok terkirim ke owner.', ['/accounts', '/approvals'])
}
