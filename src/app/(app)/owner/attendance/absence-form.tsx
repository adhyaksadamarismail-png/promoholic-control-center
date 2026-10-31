'use client'

import { useState } from 'react'
import { ActionForm, SubmitButton } from '@/components/action-form'
import { inputCls, labelCls } from '@/components/ui'
import { ABSENCE, type AbsenceKind } from '@/lib/attendance'
import { setAbsence } from './actions'

export type AbsenceShift = { id: string; admin_id: string; label: string }

/** Catat ketidakhadiran: hanya shift yang belum dimulai yang ditawarkan; aturannya diperiksa ulang di database. */
export function AbsenceForm({ staff, shifts }: { staff: { id: string; name: string }[]; shifts: AbsenceShift[] }) {
  const [admin, setAdmin] = useState(staff[0]?.id ?? '')
  const options = shifts.filter((s) => s.admin_id === admin)

  return (
    <details className="rounded-xl border border-cream-300 bg-white px-4 py-2.5 text-sm">
      <summary className="cursor-pointer font-semibold">+ Catat ketidakhadiran</summary>
      <ActionForm action={setAbsence} className="mt-3 grid gap-3 sm:grid-cols-2" resultClassName="sm:col-span-2">
        <label className={labelCls}>
          Admin
          <select value={admin} onChange={(e) => setAdmin(e.target.value)} className={inputCls}>
            {staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {/* Daftar shift berubah setelah disimpan: key mengosongkan isian form tanpa menghilangkan pesan hasil. */}
        <div key={options.length} className="contents">
          <label className={labelCls}>
            Tanggal / shift
            <select name="shift" required className={inputCls} defaultValue="">
              <option value="" disabled>{options.length ? 'Pilih shift' : 'Tidak ada shift yang bisa ditandai'}</option>
              {options.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Status
            <select name="kind" required className={inputCls} defaultValue="">
              <option value="" disabled>Pilih status</option>
              {(Object.keys(ABSENCE) as AbsenceKind[]).map((k) => <option key={k} value={k}>{ABSENCE[k].label}</option>)}
            </select>
          </label>
          <label className={labelCls}>
            Catatan (opsional)
            <input name="note" maxLength={500} placeholder="mis. izin keluarga" className={inputCls} autoComplete="off" />
          </label>
          <label className={`${labelCls} sm:col-span-2`}>
            Bukti surat izin / sakit (opsional)
            <input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" className="min-h-11 text-sm" />
            <span className="text-xs font-normal text-ink-500">JPG, PNG, WebP, atau PDF, maksimal 5 MB. Hanya owner yang bisa membuka.</span>
          </label>
          <div className="sm:col-span-2"><SubmitButton variant="accent" pendingText="Menyimpan…">Simpan ketidakhadiran</SubmitButton></div>
        </div>
      </ActionForm>
    </details>
  )
}
