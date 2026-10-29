'use server'

import { z } from 'zod'
import { callRpc, type ActionResult } from '@/lib/rpc'

export type BulkDeleteResult = { deleted: number; skipped: number; results: { id: string; code: string | null; ok: boolean; reason?: string; vouchers?: number }[] }

/** Owner: hapus banyak akun sekaligus. Per akun diproses terpisah di delete_accounts; akun bertransaksi dilewati beserta alasannya. */
export async function bulkDeleteAccounts(ids: string[]): Promise<ActionResult> {
  const p = z.array(z.string().uuid()).min(1).max(200).safeParse(ids)
  if (!p.success) return { ok: false, message: 'Pilih 1–200 akun.' }
  return callRpc('delete_accounts', { p_accounts: p.data }, 'Selesai.', ['/accounts', '/stock', '/panel', '/vm'])
}
