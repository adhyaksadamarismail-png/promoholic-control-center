import { NextResponse, type NextRequest } from 'next/server'
import { createSessionClient } from '@/lib/supabase/server'

const ALLOWED = /^(image\/jpeg|image\/png|image\/webp|application\/pdf)$/

/** Menampilkan bukti surat tanpa URL publik. Riwayat & file dibaca lewat sesi pengguna, jadi RLS membatasinya untuk owner. */
export async function GET(_: NextRequest, { params }: { params: Promise<{ log: string }> }) {
  const { log } = await params
  if (!/^\d{1,18}$/.test(log)) return new NextResponse('Not found', { status: 404 })
  const supabase = await createSessionClient()
  const { data: row } = await supabase.from('shift_absence_log').select('attachment_path').eq('id', log).maybeSingle()
  if (!row?.attachment_path) return new NextResponse('Not found', { status: 404 })

  const { data: file, error } = await supabase.storage.from('absence-proofs').download(row.attachment_path)
  if (error || !file || !ALLOWED.test(file.type)) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(await file.arrayBuffer(), {
    headers: {
      'content-type': file.type,
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
