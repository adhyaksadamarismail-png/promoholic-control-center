'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { assertOwner } from '@/lib/auth'
import { dbMessage, int, str, type ActionResult } from '@/lib/rpc'
import { createAdminClient } from '@/lib/supabase/server'
import { isYmd } from '@/lib/format'

const PATHS = ['/settings/vouchers', '/orders/new', '/accounts', '/stock', '/finance', '/panel']
const uuid = z.string().uuid()

async function audit(actor: string | undefined, action: string, entityId: string, after: unknown) {
  // Klien pengguna tidak punya hak menulis audit_log; ditulis server setelah pemanggil dipastikan owner.
  await createAdminClient().from('audit_log').insert({ actor_id: actor, action, entity: 'voucher_types', entity_id: entityId, after })
}

/**
 * Ketentuan voucher selalu disimpan sebagai versi baru dengan tanggal berlaku (RLS: insert khusus owner).
 * Kolom kosong = NULL = "belum dikonfigurasi", tidak pernah diisi angka perkiraan.
 */
export async function addVersion(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const supabase = await assertOwner().catch(() => null)
  if (!supabase) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const type = uuid.safeParse(str(fd, 'type'))
  const from = str(fd, 'from')
  if (!type.success || !isYmd(from)) return { ok: false, message: 'Pilih jenis voucher dan tanggal berlaku.' }
  const mode = str(fd, 'mode') // pct | fixed | none
  const pctRaw = str(fd, 'discount_pct').replace(',', '.')
  const pct = mode === 'pct' && pctRaw ? Number(pctRaw) : null
  const fixed = mode === 'fixed' ? int(fd, 'fixed_discount') : null
  if (pct !== null && !(pct > 0 && pct <= 100)) return { ok: false, message: 'Diskon persen harus antara 0 dan 100.' }
  if (fixed !== null && fixed < 0) return { ok: false, message: 'Potongan tetap tidak boleh negatif.' }
  const row = {
    voucher_type_id: type.data,
    discount_pct: pct,
    fixed_discount: fixed,
    min_purchase: int(fd, 'min_purchase'),
    max_discount: mode === 'pct' ? int(fd, 'max_discount') : null,
    b1g1_terms: str(fd, 'b1g1_terms') || null,
    validity_note: str(fd, 'validity_note') || null,
    effective_from: `${from}T00:00:00+07:00`,
  }
  const { data, error } = await supabase.from('voucher_type_versions').insert(row).select('id').single()
  if (error) return { ok: false, message: error.code === '23505' ? 'Sudah ada versi untuk jenis ini di tanggal yang sama.' : dbMessage(error) }
  const { data: me } = await supabase.auth.getUser()
  await audit(me.user?.id, 'voucher_version.create', type.data, { version: data.id, ...row })
  PATHS.forEach((p) => revalidatePath(p))
  return { ok: true, message: `Versi baru tersimpan, berlaku mulai ${from}. Order yang sudah tercatat tetap memakai versi lamanya.` }
}

export async function addType(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const supabase = await assertOwner().catch(() => null)
  if (!supabase) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const brand = str(fd, 'brand')
  const code = str(fd, 'code').toUpperCase()
  const name = str(fd, 'name')
  const grp = z.enum(['main', 'extra']).safeParse(str(fd, 'grp'))
  const auto = int(fd, 'auto_per_account')
  if (!/^[A-Z]{2}$/.test(brand) || !/^[A-Z0-9]{1,8}$/.test(code)) return { ok: false, message: 'Kode jenis 1–8 huruf/angka, mis. D30.' }
  if (name.length < 2 || !grp.success) return { ok: false, message: 'Isi nama dan kelompok.' }
  if (auto !== null && (auto < 0 || auto > 10)) return { ok: false, message: 'Jumlah otomatis per akun 0–10, atau kosongkan.' }
  const { data: last } = await supabase.from('voucher_types').select('sort_order').eq('brand_id', brand).order('sort_order', { ascending: false }).limit(1).maybeSingle()
  const { data, error } = await supabase
    .from('voucher_types')
    .insert({ brand_id: brand, code, name, grp: grp.data, auto_per_account: auto, sort_order: (last?.sort_order ?? 0) + 1 })
    .select('id')
    .single()
  if (error) return { ok: false, message: error.code === '23505' ? 'Kode jenis sudah dipakai di brand ini.' : dbMessage(error) }
  const { data: me } = await supabase.auth.getUser()
  await audit(me.user?.id, 'voucher_type.create', data.id, { brand, code, name, grp: grp.data, auto })
  PATHS.forEach((p) => revalidatePath(p))
  return { ok: true, message: `Jenis ${name} ditambahkan dengan status "belum dikonfigurasi". Isi ketentuannya sebagai versi baru.` }
}

export async function updateType(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const supabase = await assertOwner().catch(() => null)
  if (!supabase) return { ok: false, message: 'Akses ditolak: khusus owner' }
  const id = uuid.safeParse(str(fd, 'type'))
  const name = str(fd, 'name')
  if (!id.success || name.length < 2) return { ok: false, message: 'Isi nama jenis.' }
  const active = str(fd, 'is_active') === 'on'
  // Hanya kolom nama & status aktif yang boleh diubah (hak UPDATE kolom terbatas); angka tetap lewat versi.
  const { error } = await supabase.from('voucher_types').update({ name, is_active: active }).eq('id', id.data)
  if (error) return { ok: false, message: dbMessage(error) }
  const { data: me } = await supabase.auth.getUser()
  await audit(me.user?.id, 'voucher_type.update', id.data, { name, is_active: active })
  PATHS.forEach((p) => revalidatePath(p))
  return { ok: true, message: active ? 'Jenis voucher diperbarui.' : 'Jenis voucher dinonaktifkan: tidak dipakai untuk restock baru. Voucher yang sudah ada tetap tercatat.' }
}
