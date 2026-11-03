'use client'

import Script from 'next/script'
import { useCallback, useEffect, useRef, useState } from 'react'

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id?: string) => void
}
declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

export function LoginForm({ siteKey }: { siteKey: string }) {
  const box = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)
  const [scriptReady, setScriptReady] = useState(false)
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [redirecting, setRedirecting] = useState(false)

  const renderWidget = useCallback(() => {
    if (!box.current || !window.turnstile || widgetId.current || !siteKey) return
    widgetId.current = window.turnstile.render(box.current, {
      sitekey: siteKey,
      language: 'id',
      callback: (t: string) => setToken(t),
      'expired-callback': () => setToken(''),
      'error-callback': () => setToken(''),
    })
  }, [siteKey])

  useEffect(() => {
    if (scriptReady) renderWidget()
  }, [scriptReady, renderWidget])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!token) {
      setError('Selesaikan verifikasi CAPTCHA terlebih dahulu.')
      return
    }
    setBusy(true)
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, captchaToken: token }),
    })
    if (res.ok) {
      // Tetap dalam status sibuk sampai beranda terbuka; navigasi penuh agar cookie sesi baru langsung dipakai.
      setRedirecting(true)
      window.location.assign('/')
      return
    }
    setBusy(false)
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    setError(data.error ?? 'Login gagal. Coba lagi.')
    setPassword('')
    setToken('')
    window.turnstile?.reset(widgetId.current ?? undefined) // token CAPTCHA hanya sekali pakai
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-cream-300 bg-white p-7">
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
      />
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold">Masuk ke Control Center</h1>
        <p className="text-sm text-ink-500">Lupa password? Hubungi owner untuk reset.</p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-danger-100 px-3 py-2.5 text-sm text-[#7a1a12]">
          {error}
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm font-semibold">
        Username
        <input
          className="min-h-11 rounded-lg border border-[#dcd2bf] px-3 text-base font-normal outline-orange-500"
          autoComplete="username"
          autoCapitalize="none"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-semibold">
          Password
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="password"
            className="min-h-11 flex-1 rounded-lg border border-[#dcd2bf] px-3 text-base outline-orange-500"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="min-h-11 px-2.5 text-sm font-semibold text-navy-700"
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? 'Sembunyikan' : 'Tampilkan'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">Verifikasi CAPTCHA</span>
        <div ref={box} className="min-h-[65px]" />
        {!siteKey && <span className="text-xs text-danger-700">NEXT_PUBLIC_TURNSTILE_SITE_KEY belum diisi.</span>}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="min-h-12 rounded-lg bg-navy-900 font-semibold text-white disabled:bg-[#e7e2d8] disabled:text-[#6e7689]"
      >
        {redirecting ? 'Berhasil, membuka beranda…' : busy ? 'Memeriksa…' : 'Masuk'}
      </button>
    </form>
  )
}
