import 'server-only'
import { revalidatePath } from 'next/cache'
import { createSessionClient } from '@/lib/supabase/server'

export type ActionResult = { ok: boolean; message: string; data?: unknown }

/** Pesan dari database (raise exception) aman ditampilkan; galat lain disamarkan. */
export function dbMessage(err: { message?: string; code?: string } | null) {
  if (!err) return ''
  if (err.code === '42501') return err.message?.startsWith('Akses') ? err.message : 'Akses ditolak.'
  if (err.code === 'P0001' || err.code === '23505' || err.code === '23514') return err.message ?? 'Permintaan ditolak.'
  console.error('[rpc]', err)
  return 'Terjadi kesalahan di server. Coba lagi.'
}

/** Memanggil fungsi database dengan sesi pengguna. Izin diperiksa di dalam fungsi itu sendiri. */
export async function callRpc(fn: string, args: Record<string, unknown>, success: string, paths: string[] = []): Promise<ActionResult> {
  const supabase = await createSessionClient()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return { ok: false, message: dbMessage(error) }
  paths.forEach((p) => revalidatePath(p))
  return { ok: true, message: success, data }
}

export function str(fd: FormData, key: string) {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

export function int(fd: FormData, key: string): number | null {
  const v = str(fd, key).replace(/[−–]/g, '-').replace(/[^\d-]/g, '')
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
