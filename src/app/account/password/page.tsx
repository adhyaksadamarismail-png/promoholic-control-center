import { redirect } from 'next/navigation'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputCls, labelCls } from '@/components/ui'
import { createSessionClient } from '@/lib/supabase/server'
import { changePassword } from './actions'

export default async function ChangePasswordPage() {
  const supabase = await createSessionClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect('/login')
  const { data: profile } = await supabase.from('profiles').select('full_name, must_change_password').eq('id', auth.user.id).single()

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-cream-300 bg-white p-7">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-2xl font-bold">Ganti password</h1>
          <p className="text-sm text-ink-500">
            {profile?.must_change_password
              ? `Halo ${profile.full_name}, password Anda baru direset owner. Buat password baru sebelum melanjutkan.`
              : 'Buat password baru untuk akun Anda.'}
          </p>
        </div>
        <ActionForm action={changePassword} className="flex flex-col gap-3">
          <label className={labelCls}>
            Password baru (min. 10 karakter)
            <input type="password" name="password" required minLength={10} autoComplete="new-password" className={inputCls} />
          </label>
          <label className={labelCls}>
            Ulangi password baru
            <input type="password" name="confirm" required minLength={10} autoComplete="new-password" className={inputCls} />
          </label>
          <SubmitButton className="min-h-12">Simpan password</SubmitButton>
        </ActionForm>
        <form action="/api/auth/logout" method="post">
          <button className="text-sm font-semibold text-ink-500">Keluar</button>
        </form>
      </div>
    </main>
  )
}
