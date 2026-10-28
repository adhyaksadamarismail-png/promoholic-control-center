'use server'

import { z } from 'zod'
import { callRpc, int, str, type ActionResult } from '@/lib/rpc'

// set_restock_unit_cost: khusus owner, hanya sekali (modal yang "belum diisi"), tercatat di audit log.
export async function setRestockCost(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = z.string().uuid().safeParse(str(fd, 'restock'))
  const cost = int(fd, 'unit_cost')
  if (!id.success) return { ok: false, message: 'Permintaan tidak valid.' }
  if (cost === null || cost < 0) return { ok: false, message: 'Isi modal per voucher (0 bila gratis).' }
  const r = await callRpc('set_restock_unit_cost', { p_restock: id.data, p_unit_cost: cost }, '', ['/stock', '/finance'])
  return r.ok ? { ok: true, message: `Modal tercatat di ${r.data} voucher. Order lama tidak dihitung ulang.` } : r
}
