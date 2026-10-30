'use client'

import { useEffect, useState } from 'react'

function legacyCopy(value: string) {
  const ta = document.createElement('textarea')
  ta.value = value
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
  }
}

/** Tombol salin dengan umpan balik "Tersalin" sesaat. Diumumkan ke pembaca layar lewat aria-live. */
export function CopyButton({ value, label = 'Salin', className = '' }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = window.setTimeout(() => setState('idle'), 1600)
    return () => window.clearTimeout(t)
  }, [state])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('done')
    } catch {
      // Cadangan untuk browser yang menolak Clipboard API (izin, HTTP, webview).
      setState(legacyCopy(value) ? 'done' : 'fail')
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`${label}: ${value}`}
      className={`btn-press inline-flex min-h-8 items-center gap-1 rounded-md border px-2 text-xs font-semibold transition-colors ${
        state === 'done' ? 'border-success-700/40 bg-success-100 text-success-700' : state === 'fail' ? 'border-danger-700/40 bg-danger-100 text-danger-700' : 'border-[#dcd2bf] bg-white text-navy-900 hover:bg-cream-100'
      } ${className}`}
    >
      <span aria-hidden className={state === 'done' ? 'animate-pop' : ''}>{state === 'done' ? '✓' : state === 'fail' ? '!' : '⧉'}</span>
      <span aria-live="polite">{state === 'done' ? 'Tersalin' : state === 'fail' ? 'Gagal' : label}</span>
    </button>
  )
}
