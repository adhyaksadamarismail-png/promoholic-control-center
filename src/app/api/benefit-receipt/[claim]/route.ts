import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createSessionClient } from '@/lib/supabase/server'

const IMAGE = /^(image\/jpeg|image\/png|image\/webp)$/

/**
 * Menampilkan bukti receipt tanpa URL publik. Klaim dibaca dengan sesi pengguna (RLS: owner atau admin pemilik),
 * file diunduh lewat RLS storage, lalu dikirim dengan cache privat. Owner yang membuka tercatat sebagai sudah memeriksa.
 */
export async function GET(_: NextRequest, { params }: { params: Promise<{ claim: string }> }) {
  const { claim } = await params
  if (!z.string().uuid().safeParse(claim).success) return new NextResponse('Not found', { status: 404 })
  const supabase = await createSessionClient()
  const { data: c } = await supabase.from('benefit_claims').select('id, receipt_path').eq('id', claim).maybeSingle()
  if (!c?.receipt_path) return new NextResponse('Not found', { status: 404 })

  const { data: file, error } = await supabase.storage.from('benefit-receipts').download(c.receipt_path)
  if (error || !file || !IMAGE.test(file.type)) return new NextResponse('Not found', { status: 404 })

  const { data: role } = await supabase.rpc('current_app_role')
  if (role === 'owner') await supabase.rpc('mark_benefit_receipt_viewed', { p_claim: c.id })

  return new NextResponse(await file.arrayBuffer(), {
    headers: {
      'content-type': file.type,
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
