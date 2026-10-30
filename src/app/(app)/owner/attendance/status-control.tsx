'use client'

import { useState } from 'react'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputCls, labelCls } from '@/components/ui'
import { WORK_STATUS, type WorkStatus } from '@/lib/attendance'
import { ownerSetStatus } from './actions'

const TARGETS: Exclude<WorkStatus, 'belum'>[] = ['masuk', 'istirahat', 'off', 'selesai']
const ALLOWED: Record<WorkStatus, WorkStatus[]> = {
  belum: ['masuk'],
  masuk: ['istirahat', 'off', 'selesai'],
  istirahat: ['masuk', 'off', 'selesai'],
  off: ['masuk', 'istirahat', 'selesai'],
  selesai: [],
}

/** Tombol status untuk satu admin. Perubahan wajib beralasan; waktu kosong = sekarang (boleh mundur untuk yang lupa). */
export function StatusControl({ shiftId, adminName, current }: { shiftId: string; adminName: string; current: WorkStatus }) {
  const [target, setTarget] = useState<WorkStatus | null>(null)
  const [shownFor, setShownFor] = useState(current)
  // Status berubah (disimpan atau diperbarui otomatis): tutup form agar tidak tertinggal di status lama.
  if (shownFor !== current) {
    setShownFor(current)
    setTarget(null)
  }
  const allowed = ALLOWED[current]

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TARGETS.map((t) => (
          <button
            key={t}
            type="button"
            disabled={!allowed.includes(t)}
            aria-pressed={target === t}
            onClick={() => setTarget(target === t ? null : t)}
            className={`min-h-11 rounded-lg border px-2 text-sm font-semibold disabled:border-[#eadfcb] disabled:bg-cream-100 disabled:text-[#9aa0ad] ${
              target === t ? 'border-navy-900 bg-navy-900 text-white' : 'border-[#dcd2bf] bg-white text-navy-900'
            }`}
          >
            {WORK_STATUS[t].label}
          </button>
        ))}
      </div>
      {target && (
        <ActionForm
          key={target}
          action={ownerSetStatus}
          className="flex flex-col gap-2 rounded-xl bg-cream-100 p-3"
          confirm={`Ubah status ${adminName} menjadi ${WORK_STATUS[target].label}?`}
        >
          <input type="hidden" name="shift" value={shiftId} />
          <input type="hidden" name="status" value={target} />
          <label className={labelCls}>
            Alasan
            <input name="reason" required minLength={3} placeholder="mis. lupa klik istirahat, izin pulang" className={inputCls} autoComplete="off" />
          </label>
          <label className={labelCls}>
            Waktu (WIB, kosongkan = sekarang)
            <input type="datetime-local" name="at" className={inputCls} />
            <span className="text-xs font-normal text-ink-500">Isi bila admin lupa: mis. sebenarnya istirahat pukul 12.00. Harus setelah perubahan terakhir.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <SubmitButton variant="accent" pendingText="Menyimpan…">Simpan: {WORK_STATUS[target].label}</SubmitButton>
            <button type="button" onClick={() => setTarget(null)} className="min-h-11 rounded-lg border border-[#dcd2bf] bg-white px-4 text-sm font-semibold">Batal</button>
          </div>
        </ActionForm>
      )}
    </div>
  )
}
