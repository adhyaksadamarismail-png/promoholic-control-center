import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Variabel lingkungan ${name} belum diisi (lihat .env.example)`)
  return v
}

/** Klien dengan sesi pengguna (cookie). Semua query tunduk pada RLS. */
export async function createSessionClient() {
  const store = await cookies()
  return createServerClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options))
        } catch {
          // Dipanggil dari Server Component: cookie disegarkan oleh middleware.
        }
      },
    },
  })
}

/** Klien service role: melewati RLS. Hanya untuk route server yang sudah memeriksa izin sendiri. */
export function createAdminClient() {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function usernameToEmail(username: string) {
  return `${username}@${process.env.STAFF_EMAIL_DOMAIN ?? 'staff.promoholic.local'}`
}
