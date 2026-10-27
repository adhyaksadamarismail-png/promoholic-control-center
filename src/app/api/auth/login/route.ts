import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient, createSessionClient, usernameToEmail } from '@/lib/supabase/server'

const Body = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,32}$/),
  password: z.string().min(1).max(200),
  captchaToken: z.string().min(1).max(4096),
})

const WINDOW_MINUTES = 15
const MAX_FAILS_PER_USER = 5
const MAX_FAILS_PER_IP = 20
const GENERIC = 'Username atau password salah.'

async function verifyCaptcha(token: string, ip: string | null) {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) throw new Error('TURNSTILE_SECRET_KEY belum diisi')
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  if (!res.ok) return false
  const data = (await res.json()) as { success?: boolean }
  return data.success === true
}

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Lengkapi username, password, dan verifikasi CAPTCHA.' }, { status: 400 })
  const { username, password, captchaToken } = parsed.data
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const admin = createAdminClient()

  // Pembatasan percobaan per username dan per IP.
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString()
  const [byUser, byIp] = await Promise.all([
    admin.from('login_attempts').select('id', { count: 'exact', head: true }).eq('username', username).eq('success', false).gte('at', since),
    ip
      ? admin.from('login_attempts').select('id', { count: 'exact', head: true }).eq('ip', ip).eq('success', false).gte('at', since)
      : Promise.resolve({ count: 0 }),
  ])
  if ((byUser.count ?? 0) >= MAX_FAILS_PER_USER || (byIp.count ?? 0) >= MAX_FAILS_PER_IP) {
    return NextResponse.json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${WINDOW_MINUTES} menit.` }, { status: 429 })
  }

  // CAPTCHA diverifikasi di server sebelum password dicek.
  if (!(await verifyCaptcha(captchaToken, ip))) {
    return NextResponse.json({ error: 'Verifikasi CAPTCHA gagal. Muat ulang dan coba lagi.' }, { status: 400 })
  }

  const supabase = await createSessionClient()
  const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(username), password })
  const record = (success: boolean) => admin.from('login_attempts').insert({ username, ip, success })

  if (error) {
    await record(false)
    return NextResponse.json({ error: GENERIC }, { status: 401 })
  }

  // Peran & status aktif dibaca dari database, bukan dari input.
  const { data: role } = await supabase.rpc('current_app_role')
  if (!role) {
    await supabase.auth.signOut()
    await record(false)
    return NextResponse.json({ error: 'Akun ini nonaktif. Hubungi owner.' }, { status: 403 })
  }
  await record(true)
  return NextResponse.json({ ok: true })
}
