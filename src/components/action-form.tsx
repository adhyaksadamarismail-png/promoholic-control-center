'use client'

import { createContext, startTransition, useActionState, useContext, useEffect, useState } from 'react'

export type ActionResult = { ok: boolean; message: string; data?: unknown }
type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>

/** true setelah komponen terpasang di browser. Sebelum itu form dikunci agar tidak terkirim sebagai form HTML biasa. */
export function useHydrated() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return ready
}

const Pending = createContext<{ pending: boolean; submitter: string | null }>({ pending: false, submitter: null })

/** Form yang memanggil server action, mengunci isian selama proses, dan menampilkan hasilnya. */
export function ActionForm({
  action,
  children,
  className,
  confirm,
  resultClassName,
}: {
  action: Action
  children: React.ReactNode
  className?: string
  confirm?: string
  resultClassName?: string
}) {
  const [state, formAction, pending] = useActionState(action, null)
  const [submitter, setSubmitter] = useState<string | null>(null)
  const hydrated = useHydrated()
  return (
    <form
      className={className}
      // Dikirim manual (bukan prop action) agar isian tidak dikosongkan React saat server menolak.
      onSubmit={(e) => {
        e.preventDefault()
        if (confirm && !window.confirm(confirm)) return
        const btn = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
        const fd = new FormData(e.currentTarget, btn)
        setSubmitter(btn?.name ? `${btn.name}=${btn.value}` : null)
        startTransition(() => formAction(fd))
      }}
    >
      <Pending.Provider value={{ pending, submitter }}>
        <fieldset disabled={pending || !hydrated} className="contents">
          {children}
        </fieldset>
      </Pending.Provider>
      {state && (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={`rounded-lg px-3 py-2 text-sm ${state.ok ? 'bg-success-100 text-success-700' : 'bg-danger-100 text-[#7a1a12]'} ${resultClassName ?? ''}`}
        >
          {state.message}
        </p>
      )}
    </form>
  )
}

const VARIANTS = {
  primary: 'bg-navy-900 text-white',
  accent: 'bg-orange-500 text-navy-900',
  ghost: 'border border-[#dcd2bf] bg-white text-navy-900',
  danger: 'border border-danger-700 bg-white text-danger-700',
  success: 'bg-success-700 text-white',
}

export function SubmitButton({
  children,
  pendingText = 'Memproses…',
  variant = 'primary',
  className = '',
  name,
  value,
}: {
  children: React.ReactNode
  pendingText?: string
  variant?: keyof typeof VARIANTS
  className?: string
  name?: string
  value?: string
}) {
  const { pending, submitter } = useContext(Pending)
  // Bila beberapa tombol berbagi satu form, hanya tombol yang ditekan yang menampilkan teks proses.
  const mine = pending && (!name || submitter === `${name}=${value}`)
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={`min-h-11 rounded-lg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:bg-[#e7e2d8] disabled:text-[#6e7689] ${VARIANTS[variant]} ${className}`}
    >
      {mine ? pendingText : children}
    </button>
  )
}
