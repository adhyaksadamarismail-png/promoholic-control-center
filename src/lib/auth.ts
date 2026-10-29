import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'

export type Viewer = {
  supabase: Awaited<ReturnType<typeof createSessionClient>>
  userId: string
  profile: { full_name: string; role: 'owner' | 'staff'; must_change_password: boolean; can_restock_panel: boolean }
  isOwner: boolean
}

/** Klien sesi sekali per request (tanpa panggilan jaringan), agar halaman bisa memulai query bersamaan dengan getViewer. */
export const getSessionClient = cache(createSessionClient)

/**
 * Pengguna yang sedang membuka halaman, sekali per request (layout & halaman memakai hasil yang sama).
 * Sesi diverifikasi ke Supabase Auth (getUser) dan profil aktif dibaca dari database secara paralel;
 * null bila sesi tidak sah atau akun nonaktif. Ini hanya untuk navigasi: data tetap dilindungi RLS
 * dan setiap fungsi tulis memeriksa peran sendiri di database.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await getSessionClient()
  const [{ data: auth }, { data: profile }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.rpc('current_profile').maybeSingle<Viewer['profile'] & { id: string }>(),
  ])
  if (!auth.user || !profile || profile.id !== auth.user.id) return null
  return {
    supabase,
    userId: auth.user.id,
    profile: { full_name: profile.full_name, role: profile.role, must_change_password: profile.must_change_password, can_restock_panel: profile.can_restock_panel },
    isOwner: profile.role === 'owner',
  }
})

/** Gerbang halaman owner. Data owner tetap dilindungi RLS dan setiap fungsi tulis memanggil require_owner(). */
export async function requireOwnerPage() {
  const viewer = await getViewer()
  if (!viewer?.isOwner || viewer.profile.must_change_password) redirect('/')
  return viewer.supabase
}

/** Untuk server action yang memakai service role: pastikan pemanggil benar-benar owner aktif. */
export async function assertOwner() {
  const supabase = await createSessionClient()
  const { data: role } = await supabase.rpc('current_app_role') // null bila akun nonaktif
  if (role !== 'owner') throw new Error('Akses ditolak: khusus owner')
  return supabase
}
