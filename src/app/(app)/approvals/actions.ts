'use server'

import { z } from 'zod'
import { callRpc, str, type ActionResult } from '@/lib/rpc'

export async function decide(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = z.string().uuid().safeParse(str(fd, 'request'))
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  const approve = str(fd, 'decision') === 'approve'
  // decide_approval memeriksa require_owner() dan menjalankan perubahan + audit dalam satu transaksi.
  return callRpc('decide_approval', { p_request: id.data, p_approve: approve, p_note: str(fd, 'note') || null },
    approve ? 'Disetujui dan diterapkan.' : 'Ditolak. Keputusan tercatat, data tidak berubah.', ['/approvals', '/owner/attendance', '/attendance', '/stock', '/accounts', '/orders/new', '/finance', '/'])
}
