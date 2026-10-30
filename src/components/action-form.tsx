'use client'

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, useState } from 'react'

export type ActionResult = { ok: boolean; message: string; data?: unknown }
type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>

/** true setelah komponen terpasang di browser. Sebelum itu form dikunci agar tidak terkirim sebagai form HTML biasa. */
export function useHydrated() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return ready
}

/**
 * Dialog konfirmasi beranimasi (pengganti window.confirm). Memakai <dialog> bawaan: fokus terkunci di dalam,
 * Escape = batal. Tombol "Ya" mendapat fokus pertama agar alur keyboard sama dengan confirm() sebelumnya.
 */
export function ConfirmDialog({ message, open, onResult }: { message: string; open: boolean; onResult: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const yes = useRef<HTMLButtonElement>(null)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) { setClosing(false); d.showModal(); yes.current?.focus() }
  }, [open])
  function finish(ok: boolean) {
    const d = ref.current
    if (!d || closing) return
    setClosing(true)
    window.setTimeout(() => { d.close(); setClosing(false); onResult(ok) }, 140)
  }
  return (
    <dialog
      ref={ref}
      aria-label="Konfirmasi"
      onCancel={(e) => { e.preventDefault(); finish(false) }}
      onClick={(e) => { if (e.target === e.currentTarget) finish(false) }}
      className={`confirm-dialog m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-navy-900 shadow-2xl ${closing ? 'closing' : ''}`}
    >
      <div className="flex flex-col gap-4 p-5">
        <p className="text-[15px] font-semibold leading-snug">{message}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => finish(false)} className="min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold hover:bg-cream-100">Batal</button>
          <button ref={yes} type="button" onClick={() => finish(true)} className="min-h-11 rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white hover:bg-navy-700">Ya, lanjutkan</button>
        </div>
      </div>
    </dialog>
  )
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
  const [asking, setAsking] = useState(false)
  const queued = useRef<{ fd: FormData; submitter: string | null } | null>(null) // isian saat tombol ditekan, menunggu konfirmasi
  const hydrated = useHydrated()
  const send = (fd: FormData, by: string | null) => {
    setSubmitter(by)
    startTransition(() => formAction(fd))
  }
  return (
    <form
      className={className}
      // Dikirim manual (bukan prop action) agar isian tidak dikosongkan React saat server menolak.
      onSubmit={(e) => {
        e.preventDefault()
        const btn = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
        const fd = new FormData(e.currentTarget, btn)
        const by = btn?.name ? `${btn.name}=${btn.value}` : null
        if (!confirm) return send(fd, by)
        queued.current = { fd, submitter: by }
        setAsking(true)
      }}
    >
      {confirm && (
        <ConfirmDialog
          message={confirm}
          open={asking}
          onResult={(ok) => {
            setAsking(false)
            const q = queued.current
            queued.current = null
            if (ok && q) send(q.fd, q.submitter)
          }}
        />
      )}
      <Pending.Provider value={{ pending, submitter }}>
        <fieldset disabled={pending || !hydrated} className="contents">
          {children}
        </fieldset>
      </Pending.Provider>
      {state && (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={`animate-enter rounded-lg px-3 py-2 text-sm ${state.ok ? 'bg-success-100 text-success-700' : 'bg-danger-100 text-[#7a1a12]'} ${resultClassName ?? ''}`}
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
      className={`min-h-11 rounded-lg px-4 text-sm font-semibold hover:brightness-110 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:bg-[#e7e2d8] disabled:text-[#6e7689] ${VARIANTS[variant]} ${className}`}
    >
      {mine ? <span className="inline-flex items-center gap-2"><span className="spinner" aria-hidden />{pendingText}</span> : children}
    </button>
  )
}
