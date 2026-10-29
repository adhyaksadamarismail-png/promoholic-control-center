import 'server-only'
import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'

/**
 * Gerbang halaman owner. Ini hanya untuk navigasi: data owner tetap dilindungi RLS
 * dan setiap fungsi tulis memanggil require_owner() di database.
 */
export async function requireOwnerPage() {
  const supabase = await createSessionClient()
  const { data: role } = await supabase.rpc('current_app_role')
  if (role !== 'owner') redirect('/')
  return supabase
}

/** Untuk server action yang memakai service role: pastikan pemanggil benar-benar owner aktif. */
export async function assertOwner() {
  const supabase = await createSessionClient()
  const { data: role } = await supabase.rpc('current_app_role') // null bila akun nonaktif
  if (role !== 'owner') throw new Error('Akses ditolak: khusus owner')
  return supabase
}
