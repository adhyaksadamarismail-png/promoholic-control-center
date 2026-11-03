'use server'

import { redirect } from 'next/navigation'
import { dbMessage, str, type ActionResult } from '@/lib/rpc'
import { createSessionClient } from '@/lib/supabase/server'

export async function changePassword(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const password = str(fd, 'password')
  if (password.length < 10) return { ok: false, message: 'Password minimal 10 karakter.' }
  if (password !== str(fd, 'confirm')) return { ok: false, message: 'Konfirmasi password tidak sama.' }
  if (password.startsWith('Tmp-')) return { ok: false, message: 'Gunakan password baru, bukan password sementara.' }
  const supabase = await createSessionClient()
  const { error } = await supabase.auth.updateUser({ password })
  if (error) return { ok: false, message: error.code === 'same_password' ? 'Password baru harus berbeda dari yang lama.' : 'Gagal mengganti password.' }
  const { error: e2 } = await supabase.rpc('mark_password_changed')
  if (e2) return { ok: false, message: dbMessage(e2) }
  redirect('/')
}
