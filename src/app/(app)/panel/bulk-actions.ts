'use server'

import { z } from 'zod'
import { callRpc, type ActionResult } from '@/lib/rpc'

// Hak akses ditegakkan di database: bulk Panel butuh izin restock, bulk VM khusus owner.
const Row = z.object({
  line: z.number().int(),
  device: z.string().max(16).nullable(),
  code: z.string().max(40).nullable(),
  number: z.string().max(24).nullable(),
  items: z.record(z.string().regex(/^[A-Z0-9]{1,8}$/), z.number().int().min(0).max(20)),
})
const Input = z.object({
  source: z.enum(['panel', 'vm']),
  mode: z.enum(['new_account', 'add_stock', 'extra_only']),
  brand: z.string().regex(/^[A-Z]{2}$/).nullable(),
  rows: z.array(Row).min(1).max(300),
})
const PATHS = ['/panel', '/vm', '/stock', '/accounts', '/orders/new', '/']

export async function previewBulk(input: z.input<typeof Input>): Promise<ActionResult> {
  const p = Input.safeParse(input)
  if (!p.success) return { ok: false, message: 'Data tidak valid. Periksa format baris.' }
  return callRpc('bulk_restock_validate', { p_source: p.data.source, p_mode: p.data.mode, p_brand: p.data.brand, p_rows: p.data.rows }, '')
}

export async function commitBulk(
  input: z.input<typeof Input> & { unitCost: number | null; sourceNote: string; idem: string },
): Promise<ActionResult> {
  const p = Input.safeParse(input)
  const idem = z.string().uuid().safeParse(input.idem)
  if (!p.success || !idem.success) return { ok: false, message: 'Data tidak valid. Ulangi preview.' }
  const cost = input.unitCost === null ? null : z.number().int().min(0).safeParse(input.unitCost)
  if (cost && !cost.success) return { ok: false, message: 'Modal per voucher tidak valid.' }
  return callRpc('bulk_restock', {
    p_source: p.data.source, p_mode: p.data.mode, p_brand: p.data.brand, p_rows: p.data.rows,
    p_unit_cost: cost ? cost.data : null, p_source_note: input.sourceNote.trim() || null, p_idem: idem.data,
  }, 'Restock tersimpan.', PATHS)
}

// Bulk Baperan: satu baris = nomor telepon | PIN. Izin & semua aturan diperiksa di database.
const BaperanRow = z.object({ line: z.number().int(), number: z.string().max(24), pin: z.string().max(8).nullable() })
const BaperanRows = z.array(BaperanRow).min(1).max(300)

export async function previewBulkBaperan(rows: z.input<typeof BaperanRows>): Promise<ActionResult> {
  const p = BaperanRows.safeParse(rows)
  if (!p.success) return { ok: false, message: 'Data tidak valid. Periksa format baris (nomor | PIN).' }
  return callRpc('bulk_restock_baperan_validate', { p_rows: p.data }, '')
}

export async function commitBulkBaperan(input: {
  rows: z.input<typeof BaperanRows>; activeUntil: string; receivedOn: string; unitCost: number | null; sourceNote: string; idem: string
}): Promise<ActionResult> {
  const rows = BaperanRows.safeParse(input.rows)
  const idem = z.string().uuid().safeParse(input.idem)
  const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  if (!rows.success || !idem.success) return { ok: false, message: 'Data tidak valid. Ulangi preview.' }
  if (!ymd.safeParse(input.activeUntil).success) return { ok: false, message: 'Isi tanggal berakhir masa aktif.' }
  if (!ymd.safeParse(input.receivedOn).success) return { ok: false, message: 'Tanggal restock tidak valid.' }
  const cost = input.unitCost === null ? null : z.number().int().min(0).safeParse(input.unitCost)
  if (cost && !cost.success) return { ok: false, message: 'Modal per voucher tidak valid.' }
  return callRpc('bulk_restock_baperan', {
    p_rows: rows.data, p_active_until: input.activeUntil, p_received_on: input.receivedOn,
    p_unit_cost: cost ? cost.data : null, p_source_note: input.sourceNote.trim() || null, p_idem: idem.data,
  }, 'Restock tersimpan.', PATHS)
}
