/* eslint-disable @typescript-eslint/no-unused-expressions */
// Uji keamanan & alur lewat API Supabase lokal, persis seperti penyerang yang memegang anon key (publik).
// Mengubah data: jalankan setelah `npm run db:reset`, lalu reset lagi bila ingin data awal.
// Jalankan: npm run test:security
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const PASSWORD = 'DevOnly-Promoholic-2026'
const CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX' // token dummy: diterima kunci rahasia uji Turnstile di supabase/.env
const domain = env.STAFF_EMAIL_DOMAIN || 'staff.promoholic.local'

let failed = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failed++; console.log('  ✗ ' + m) }
const section = (m) => console.log('\n' + m)
const client = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })

async function signIn(username, { captcha = true } = {}) {
  const c = client()
  const { error } = await c.auth.signInWithPassword({
    email: `${username}@${domain}`,
    password: PASSWORD,
    options: captcha ? { captchaToken: CAPTCHA } : undefined,
  })
  return { c, error }
}
async function expectDenied(name, p) {
  const { data, error } = await p
  if (error) return ok(`${name} — ditolak (${(error.code || '') + ' ' + error.message.slice(0, 60)})`)
  if (Array.isArray(data) && data.length === 0) return ok(`${name} — 0 baris`)
  bad(`${name} — TIDAK ditolak: ${JSON.stringify(data).slice(0, 120)}`)
}
async function expectOk(name, p) {
  const { data, error } = await p
  if (error) { bad(`${name} — gagal: ${error.message}`); return null }
  ok(name)
  return data
}

// ───────────────────────────────────────────────────────────
section('1. Login langsung ke Supabase Auth (melewati route aplikasi)')
{
  const { error } = await signIn('rani', { captcha: false })
  error ? ok(`login tanpa token CAPTCHA ditolak (${error.message.slice(0, 60)})`) : bad('login tanpa CAPTCHA BERHASIL lewat API langsung — CAPTCHA & rate limit aplikasi bisa dilewati')
  const signup = await client().auth.signUp({ email: `penyusup@${domain}`, password: 'Penyusup-12345', options: { captchaToken: CAPTCHA } })
  signup.error ? ok(`pendaftaran publik ditolak (${signup.error.message.slice(0, 50)})`) : bad('pendaftaran publik BERHASIL')
}

// ───────────────────────────────────────────────────────────
section('2. Pengguna anonim (hanya anon key)')
{
  const a = client()
  for (const t of ['profiles', 'accounts', 'account_list', 'vouchers', 'orders', 'voucher_usage_list', 'shifts', 'audit_log', 'login_attempts', 'weekly_payrolls', 'vm_devices', 'brands'])
    await expectDenied(`anon baca ${t}`, a.from(t).select('*').limit(1))
  await expectDenied('anon panggil record_order', a.rpc('record_order', { p_voucher: randomUUID(), p_customer_name: 'x', p_customer_wa: '081234567890', p_ref: null, p_menu_price: 1, p_sell_price: 1, p_extra_cost: 0, p_manual_discount: null, p_price_after_override: null, p_confirm: true, p_idem: randomUUID() }))
  await expectDenied('anon panggil current_app_role', a.rpc('current_app_role'))
}

const { c: owner } = await signIn('owner')
const { c: rani } = await signIn('rani')
const { c: dimas } = await signIn('dimas')
const { c: sekar } = await signIn('sekar')
const id = async (c) => (await c.auth.getUser()).data.user.id
const ids = { owner: await id(owner), rani: await id(rani), dimas: await id(dimas), sekar: await id(sekar) }

// ───────────────────────────────────────────────────────────
section('3. Staf membaca data yang bukan haknya')
{
  await expectDenied('staf baca tabel accounts (nomor & identitas asli)', rani.from('accounts').select('*'))
  await expectDenied('staf baca vm_devices', rani.from('vm_devices').select('*'))
  await expectDenied('staf baca audit_log', rani.from('audit_log').select('*'))
  await expectDenied('staf baca login_attempts', rani.from('login_attempts').select('*'))
  await expectDenied('staf baca pembelian persediaan', rani.from('inventory_purchases').select('*'))
  await expectDenied('staf baca biaya operasional', rani.from('expenses').select('*'))
  await expectDenied('staf baca order admin lain', rani.from('orders').select('code').neq('admin_id', ids.rani))
  await expectDenied('staf baca shift admin lain', rani.from('shifts').select('code').neq('admin_id', ids.rani))
  await expectDenied('staf baca rekap gaji admin lain', rani.from('weekly_payrolls').select('id').neq('admin_id', ids.rani))
  await expectDenied('staf baca uang saku admin lain', rani.from('shift_earnings').select('id').neq('admin_id', ids.rani))
  const { data: acc } = await rani.from('account_list').select('account_number, vm_device_id, identity_note').not('account_number', 'is', null).limit(3)
  acc?.length && acc.every((a) => a.account_number.includes('•') && !a.vm_device_id && !a.identity_note)
    ? ok('nomor akun VM tersamar, device & identitas kosong untuk staf')
    : bad('account_list membocorkan data: ' + JSON.stringify(acc))
  const { data: use } = await dimas.from('voucher_usage_list').select('customer_wa, admin_id').neq('admin_id', ids.dimas).limit(3)
  use?.length && use.every((u) => u.customer_wa.includes('•')) ? ok('WhatsApp customer order admin lain tersamar') : bad('voucher_usage_list: ' + JSON.stringify(use))
}

// ───────────────────────────────────────────────────────────
section('4. Staf menulis langsung ke tabel (melewati fungsi server)')
{
  await expectDenied('staf ubah perannya sendiri jadi owner', rani.from('profiles').update({ role: 'owner' }).eq('id', ids.rani).select())
  await expectDenied('staf aktifkan izin restock sendiri', dimas.from('profiles').update({ can_restock_panel: true }).eq('id', ids.dimas).select())
  await expectDenied('staf sisipkan profil owner baru', rani.from('profiles').insert({ id: randomUUID(), username: 'palsu', full_name: 'Palsu', role: 'owner' }).select())
  const { data: v } = await rani.from('vouchers').select('id, account_id').eq('status', 'available').limit(1).single()
  await expectDenied('staf ubah status voucher langsung', rani.from('vouchers').update({ status: 'available' }).eq('id', v.id).select())
  await expectDenied('staf hapus voucher', rani.from('vouchers').delete().eq('id', v.id).select())
  await expectDenied('staf tulis histori stok', rani.from('stock_ledger').insert({ voucher_id: v.id, account_id: v.account_id, delta: 1, reason: 'restock', status_after: 'available' }).select())
  await expectDenied('staf hapus histori stok', rani.from('stock_ledger').delete().gt('id', 0).select())
  await expectDenied('staf hapus audit log', rani.from('audit_log').delete().gt('id', 0).select())
  await expectDenied('staf ubah order', rani.from('orders').update({ net_profit: 999999 }).eq('admin_id', ids.rani).select())
  await expectDenied('staf sisipkan klaim benefit langsung', rani.from('benefit_claims').insert({ entitlement_id: randomUUID() }).select())
  await expectDenied('staf sisipkan event absen langsung', rani.from('attendance_events').insert({ shift_id: randomUUID(), kind: 'clock_in' }).select())
  await expectDenied('staf tambah versi aturan voucher', rani.from('voucher_type_versions').insert({ voucher_type_id: randomUUID(), discount_pct: 100, effective_from: new Date().toISOString() }).select())
  await expectDenied('staf ubah nama jenis voucher', rani.from('voucher_types').update({ name: 'x' }).neq('id', randomUUID()).select())
  await expectDenied('staf tambah aturan bonus', rani.from('bonus_rules').insert({ method: 'fixed_per_shift', fixed_rp: 1000000, effective_from: new Date().toISOString() }).select())
  await expectDenied('staf ubah harga kredit', rani.from('credit_prices').insert({ rp_per_credit: 1, effective_from: new Date().toISOString() }).select())
  await expectDenied('staf ubah rekap gaji', rani.from('weekly_payrolls').update({ approved_total: 9999999 }).eq('admin_id', ids.rani).select())
  await expectDenied('staf tambah jadwal', rani.from('schedule_templates').insert({ admin_id: ids.rani, weekday: 1, start_time: '08:00', end_time: '09:00', effective_from: '2026-01-01' }).select())
}

// ───────────────────────────────────────────────────────────
section('5. Staf memanggil fungsi khusus owner / internal')
{
  const any = randomUUID()
  const calls = [
    ['vm_add_account', { p_device: 'VD-01', p_code: 'KK-0999', p_number: '081299990000', p_active_until: null, p_manual: {}, p_idem: any }],
    ['vm_add_device', { p_name: 'Device Penyusup', p_note: null }],
    ['vm_update_account', { p_account: any, p_number: '081200000000', p_device: 'VD-01', p_active_until: null }],
    ['decide_approval', { p_request: any, p_approve: true, p_note: null }],
    ['decide_earning', { p_earning: any, p_approve: true, p_note: null }],
    ['build_weekly_payroll', { p_admin: ids.rani, p_period_start: '2026-10-26' }],
    ['approve_weekly_payroll', { p_payroll: any, p_adjustments: [] }],
    ['mark_payroll_paid', { p_payroll: any, p_note: null }],
    ['generate_regular_shifts', { p_week_start: '2026-11-02' }],
    ['add_extra_shift', { p_admin: ids.rani, p_start: '2026-11-01T10:00:00+07:00', p_end: '2026-11-01T20:00:00+07:00' }],
    ['set_schedule', { p_admin: ids.rani, p_weekdays: [1], p_start: '08:00', p_end: '20:00', p_break: 60, p_effective_from: '2026-12-01', p_note: 'penyusup' }],
    ['set_staff_active', { p_profile: ids.sekar, p_active: false }],
    ['set_staff_permission', { p_profile: ids.dimas, p_can_restock: true }],
    ['revoke_sessions', { p_profile: ids.owner }],
    ['flag_incomplete_shifts', {}],
    ['_create_account', { p_brand: 'KK', p_code: 'KK-0998', p_source: 'panel', p_device: null, p_number: null, p_identity: null, p_active_until: null, p_manual: {}, p_idem: any }],
    ['_compute_earning', { p_shift: any }],
    ['write_audit', { p_action: 'x', p_entity: 'x', p_entity_id: 'x', p_before: null, p_after: null }],
  ]
  for (const [fn, args] of calls) await expectDenied(`staf panggil ${fn}`, rani.rpc(fn, args))
  await expectDenied('staf tanpa izin restock membuat akun Panel', dimas.rpc('panel_add_account', { p_brand: 'FR', p_code: 'FR-0900', p_identity: null, p_active_until: null, p_manual: { D25: 1 }, p_idem: randomUUID() }))
  const { data: vmAcc } = await owner.from('accounts').select('id').eq('source', 'vm').limit(1).single()
  await expectDenied('staf berizin menambah stok ke akun VM', rani.rpc('add_stock', { p_account: vmAcc.id, p_items: [{ type: 'BP', qty: 1 }], p_idem: randomUUID() }))
  const { data: other } = await owner.from('shifts').select('id').eq('admin_id', ids.dimas).limit(1).single()
  await expectDenied('staf absen di shift admin lain', rani.rpc('attendance_action', { p_shift: other.id, p_kind: 'clock_in' }))
  await expectDenied('staf ajukan benefit shift admin lain', rani.rpc('submit_benefit_claim', { p_shift: other.id, p_cup_size: 'regular', p_receipt_path: `${ids.rani}/${other.id}/x.jpg` }))
  await expectDenied('klaim lama tanpa ukuran & bukti', rani.rpc('claim_benefit', { p_shift: other.id }))
  await expectDenied('staf memverifikasi klaim benefit', rani.rpc('verify_benefit_claim', { p_claim: randomUUID(), p_approve: true, p_note: null }))
  await expectDenied('staf menandai bukti sudah diperiksa', rani.rpc('mark_benefit_receipt_viewed', { p_claim: randomUUID() }))
  await expectDenied('staf tanpa izin restock Baperan saja', dimas.rpc('restock_extra_only', { p_type: randomUUID(), p_qty: 1, p_account: null, p_unit_cost: 0, p_source_note: 'uji', p_received_on: '2026-10-28', p_idem: randomUUID() }))
  await expectDenied('staf mengisi modal restock', rani.rpc('set_restock_unit_cost', { p_restock: randomUUID(), p_unit_cost: 0 }))
  await expectDenied('staf menetapkan ketidakhadiran', rani.rpc('set_shift_absence', { p_shift: randomUUID(), p_kind: 'izin', p_note: null, p_attachment: null, p_reason: null }))
  const { data: absLog } = await rani.from('shift_absence_log').select('id')
  !absLog?.length ? ok('staf tidak bisa membaca catatan ketidakhadiran') : bad('catatan ketidakhadiran terbaca staf')
  const { error: proofErr } = await rani.storage.from('absence-proofs').upload(`${randomUUID()}/x.pdf`, new Uint8Array([37, 80, 68, 70, 45]), { contentType: 'application/pdf' })
  proofErr ? ok('staf tidak bisa mengunggah bukti ketidakhadiran') : bad('staf bisa mengunggah bukti ketidakhadiran')
  await expectDenied('staf tanpa izin bulk Baperan', dimas.rpc('bulk_restock_baperan', { p_rows: [{ line: 1, number: '081255509998', pin: null }], p_active_until: '2026-12-31', p_received_on: '2026-10-28', p_unit_cost: null, p_source_note: null, p_idem: randomUUID() }))
  await expectDenied('staf memanggil fungsi internal Baperan', rani.rpc('_create_baperan', { p_phone: '081255509997', p_pin: null, p_unit_cost: null, p_received_on: '2026-10-28', p_active_until: '2026-12-31', p_source_note: null, p_idem: randomUUID(), p_batch: null }))
  await expectDenied('staf memanggil fungsi internal ID Baperan', rani.rpc('_create_baperan', { p_phone: null, p_pin: null, p_unit_cost: null, p_received_on: '2026-10-28', p_active_until: '2026-12-31', p_source_note: null, p_idem: randomUUID(), p_batch: null, p_account_id: '999001' }))
  await expectDenied('staf tanpa izin bulk Baperan ID', dimas.rpc('bulk_restock_baperan', { p_rows: [{ line: 1, account_id: '999002' }], p_active_until: '2026-12-31', p_received_on: '2026-10-28', p_unit_cost: null, p_source_note: null, p_idem: randomUUID() }))
  await expectDenied('staf tanpa izin restock Baperan', dimas.rpc('restock_baperan', { p_phone: '081255509999', p_pin: null, p_unit_cost: null, p_received_on: '2026-10-28', p_active_until: '2026-12-31', p_source_note: 'uji', p_idem: randomUUID() }))
  const { data: bpAcc } = await owner.from('accounts').select('id').eq('inventory', 'baperan').not('pin', 'is', null).limit(1).single()
  await expectDenied('staf mengubah masa aktif / PIN Baperan', rani.rpc('owner_update_baperan', { p_account: bpAcc.id, p_active_until: '2030-01-01', p_pin: null, p_reason: 'uji' }))
  const { data: pinRaw } = await rani.from('accounts').select('pin').eq('id', bpAcc.id)
  !pinRaw?.length ? ok('staf tidak bisa membaca PIN dari tabel akun') : bad('PIN Baperan terbaca staf lewat tabel akun')
  const { data: pinView } = await rani.from('account_list').select('pin, account_number').eq('id', bpAcc.id).single()
  pinView && pinView.pin === null && /^08\d+$/.test(pinView.account_number) ? ok('staf: nomor Baperan utuh, PIN kosong di view') : bad('view Baperan staf: ' + JSON.stringify(pinView))
  const { data: ownerView } = await owner.from('account_list').select('pin').eq('id', bpAcc.id).single()
  ownerView?.pin ? ok('owner melihat PIN Baperan') : bad('owner tidak melihat PIN')
  const { error: upErr } = await rani.from('accounts').update({ active_until: '2030-01-01' }).eq('id', bpAcc.id)
  const { data: after } = await owner.from('accounts').select('active_until').eq('id', bpAcc.id).single()
  after?.active_until !== '2030-01-01' ? ok('staf tidak bisa mengubah masa aktif langsung' + (upErr ? ` (${upErr.code})` : '')) : bad('masa aktif diubah staf')
}

// ───────────────────────────────────────────────────────────
section('6. Alur bersamaan & kiriman ganda')
{
  const { data: v } = await owner.from('vouchers').select('id, code').like('code', 'V-KK%-A').eq('status', 'available').limit(1).single()
  const args = (idem) => ({ p_voucher: v.id, p_customer_name: 'Uji Bersamaan', p_customer_wa: '081234567890', p_ref: null, p_menu_price: 60000, p_sell_price: 40000, p_extra_cost: 0, p_manual_discount: null, p_price_after_override: null, p_confirm: true, p_idem: idem })
  const res = await Promise.all([rani.rpc('record_order', args(randomUUID())), sekar.rpc('record_order', args(randomUUID())), dimas.rpc('record_order', args(randomUUID()))])
  const wins = res.filter((r) => !r.error).length
  wins === 1 ? ok(`3 admin memakai ${v.code} bersamaan → hanya 1 berhasil`) : bad(`${wins} order berhasil memakai voucher yang sama`)

  const idem = randomUUID()
  const code = 'FR-07' + String(Math.floor(Math.random() * 90) + 10)
  const two = await Promise.all([1, 2].map(() => rani.rpc('panel_add_account', { p_brand: 'FR', p_code: code, p_identity: null, p_active_until: null, p_manual: { D25: 2 }, p_idem: idem })))
  const codes = new Set(two.filter((r) => !r.error).map((r) => r.data))
  const { count } = await owner.from('accounts').select('id', { count: 'exact', head: true }).eq('account_code', code)
  count === 1 && codes.size <= 1 ? ok(`restock dikirim 2× bersamaan (kunci sama) → 1 akun ${code}`) : bad(`restock ganda: ${count} akun, kode ${[...codes]}`)
  await expectDenied('akun dengan ID sama tidak bisa dibuat ulang', rani.rpc('panel_add_account', { p_brand: 'FR', p_code: code, p_identity: null, p_active_until: null, p_manual: { D25: 1 }, p_idem: randomUUID() }))

  // Cari staf yang punya shift berjalan sekarang (jadwal seed bergantung hari & jam saat uji dijalankan).
  const nowIso = new Date().toISOString()
  // Bila tidak ada shift berjalan (tergantung jam uji), owner membuat shift tambahan untuk Sekar mulai sekarang.
  const { data: running } = await owner.from('shifts').select('id').eq('status', 'scheduled')
    .lte('planned_start', new Date(Date.now() + 2 * 3600e3).toISOString()).gte('planned_end', nowIso).in('admin_id', [ids.rani, ids.sekar]).limit(1)
  if (!running?.length) await owner.rpc('add_extra_shift', { p_admin: ids.sekar, p_start: new Date(Date.now() - 60e3).toISOString(), p_end: new Date(Date.now() + 4 * 3600e3).toISOString() })
  const { data: sh } = await owner.from('shifts').select('id, admin_id').eq('status', 'scheduled')
    .lte('planned_start', new Date(Date.now() + 2 * 3600e3).toISOString()).gte('planned_end', nowIso).in('admin_id', [ids.rani, ids.sekar])
    .limit(1).maybeSingle()
  const who = sh?.admin_id === ids.rani ? rani : sekar
  if (sh) {
    const starts = await Promise.all([1, 2].map(() => who.rpc('attendance_action', { p_shift: sh.id, p_kind: 'clock_in' })))
    starts.filter((r) => !r.error).length === 1 ? ok('absen masuk 2× bersamaan → 1 tercatat') : bad('absen masuk ganda')
    const me = sh.admin_id
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const paths = [1, 2, 3].map((n) => `${me}/${sh.id}/uji-${n}-${randomUUID()}.jpg`)
    for (const pth of paths) await who.storage.from('benefit-receipts').upload(pth, jpg, { contentType: 'image/jpeg' })
    const claims = await Promise.all(paths.map((pth) => who.rpc('submit_benefit_claim', { p_shift: sh.id, p_cup_size: 'regular', p_receipt_path: pth })))
    const n = claims.filter((r) => !r.error).length
    n === 1 ? ok('pengajuan benefit 3× bersamaan → 1 tercatat (Menunggu Verifikasi)') : bad(`${n} pengajuan benefit tercatat`)
    const claimId = claims.find((r) => !r.error)?.data
    await expectDenied('owner menyetujui tanpa membuka bukti', owner.rpc('verify_benefit_claim', { p_claim: claimId, p_approve: true, p_note: null }))
    await owner.rpc('mark_benefit_receipt_viewed', { p_claim: claimId })
    const twice = await Promise.all([1, 2].map(() => owner.rpc('verify_benefit_claim', { p_claim: claimId, p_approve: true, p_note: null })))
    twice.filter((r) => !r.error).length === 1 ? ok('persetujuan ganda bersamaan → 1 berhasil') : bad('persetujuan ganda')
    const outs = await Promise.all([1, 2].map(() => who.rpc('attendance_action', { p_shift: sh.id, p_kind: 'clock_out' })))
    outs.filter((r) => !r.error).length === 1 ? ok('absen pulang 2× bersamaan → 1 tercatat') : bad('absen pulang ganda')
  } else console.log('  · (lewati uji absen/klaim bersamaan: tidak ada shift Rani/Sekar yang sedang berjalan saat ini)')
}

// ───────────────────────────────────────────────────────────
section('6a. Bulk restock')
{
  const vmRows = [{ line: 1, device: 'VD-01', code: '' + (700000 + Math.floor(Math.random() * 99999)), number: '0812' + Math.floor(10000000 + Math.random() * 89999999), items: {} }]
  await expectDenied('staf bulk restock Virtual Machine', rani.rpc('bulk_restock', { p_source: 'vm', p_mode: 'new_account', p_brand: null, p_rows: vmRows, p_unit_cost: null, p_source_note: null, p_idem: randomUUID() }))
  await expectDenied('staf tanpa izin bulk restock Panel', dimas.rpc('bulk_restock', { p_source: 'panel', p_mode: 'new_account', p_brand: 'KK', p_rows: [{ line: 1, code: '799999', items: {} }], p_unit_cost: null, p_source_note: null, p_idem: randomUUID() }))
  await expectDenied('staf menulis tabel batch langsung', rani.from('restock_batches').insert({ source: 'panel', mode: 'new_account', idempotency_key: randomUUID() }).select())
  const base = 600000 + Math.floor(Math.random() * 99999)
  const rows = [0, 1, 2].map((i) => ({ line: i + 1, device: null, code: String(base + i), number: null, items: {} }))
  const idem = randomUUID()
  const two = await Promise.all([1, 2].map(() => rani.rpc('bulk_restock', { p_source: 'panel', p_mode: 'new_account', p_brand: 'KK', p_rows: rows, p_unit_cost: null, p_source_note: null, p_idem: idem })))
  const { count } = await owner.from('accounts').select('id', { count: 'exact', head: true }).in('account_code', rows.map((r) => r.code))
  const { count: batches } = await owner.from('restock_batches').select('id', { count: 'exact', head: true }).eq('idempotency_key', idem)
  count === 3 && batches === 1 ? ok(`batch dikirim 2× bersamaan → 1 batch, 3 akun (${two.filter((r) => !r.error).length} respons berhasil)`) : bad(`batch ganda: ${count} akun, ${batches} batch`)
  const { data: vis } = await rani.from('restock_batches').select('source')
  vis?.every((b) => b.source === 'panel') ? ok('staf tidak melihat batch Virtual Machine') : bad('staf melihat batch VM')
}

// ───────────────────────────────────────────────────────────
section('6b. Storage privat bukti receipt')
{
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const mine = `${ids.rani}/${randomUUID()}/uji.jpg`
  const up = await rani.storage.from('benefit-receipts').upload(mine, jpg, { contentType: 'image/jpeg' })
  up.error ? bad('staf gagal unggah ke foldernya sendiri: ' + up.error.message) : ok('staf mengunggah ke foldernya sendiri')
  const other = await rani.storage.from('benefit-receipts').upload(`${ids.dimas}/${randomUUID()}/palsu.jpg`, jpg, { contentType: 'image/jpeg' })
  other.error ? ok('staf tidak bisa mengunggah ke folder admin lain') : bad('staf mengunggah ke folder admin lain')
  const html = await rani.storage.from('benefit-receipts').upload(`${ids.rani}/${randomUUID()}/x.html`, new TextEncoder().encode('<script>1</script>'), { contentType: 'text/html' })
  html.error ? ok('file non-gambar ditolak bucket') : bad('file HTML diterima bucket')
  const peek = await dimas.storage.from('benefit-receipts').download(mine)
  peek.error ? ok('staf lain tidak bisa mengunduh bukti milik Rani') : bad('staf lain mengunduh bukti Rani')
  const anonDl = await client().storage.from('benefit-receipts').download(mine)
  anonDl.error ? ok('anonim tidak bisa mengunduh bukti') : bad('anonim mengunduh bukti')
  const pub = await fetch(client().storage.from('benefit-receipts').getPublicUrl(mine).data.publicUrl)
  pub.ok ? bad('bukti terbuka lewat URL publik') : ok(`URL publik tidak berlaku (HTTP ${pub.status})`)
  const own = await owner.storage.from('benefit-receipts').download(mine)
  own.error ? bad('owner tidak bisa membuka bukti: ' + own.error.message) : ok('owner bisa membuka bukti')
  const del = await rani.storage.from('benefit-receipts').remove([mine])
  const still = await owner.storage.from('benefit-receipts').download(mine)
  !still.error ? ok('bukti tidak bisa dihapus/diganti staf setelah diunggah') : bad('staf menghapus bukti: ' + JSON.stringify(del.data))
}

// ───────────────────────────────────────────────────────────
section('7. Akun nonaktif & token palsu')
{
  await expectOk('owner menonaktifkan Bayu', owner.rpc('set_staff_active', { p_profile: (await owner.from('profiles').select('id').eq('username', 'bayu').single()).data.id, p_active: false }))
  const { c: bayu, error } = await signIn('bayu')
  if (error) ok('akun nonaktif tidak bisa login: ' + error.message.slice(0, 50))
  else {
    await expectDenied('token akun nonaktif membaca shift', bayu.from('shifts').select('id'))
    await expectDenied('token akun nonaktif mencatat order', bayu.rpc('record_order', { p_voucher: randomUUID(), p_customer_name: 'x', p_customer_wa: '081234567890', p_ref: null, p_menu_price: 1, p_sell_price: 1, p_extra_cost: 0, p_manual_discount: null, p_price_after_override: null, p_confirm: true, p_idem: randomUUID() }))
  }
  await owner.rpc('set_staff_active', { p_profile: (await owner.from('profiles').select('id').eq('username', 'bayu').single()).data.id, p_active: true })

  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ sub: ids.owner, role: 'authenticated', exp: 9999999999 })).toString('base64url')
  const forged = `${head}.${body}.${Buffer.from('tanda-tangan-palsu').toString('base64url')}`
  const f = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${forged}` } }, auth: { persistSession: false } })
  await expectDenied('token JWT palsu atas nama owner', f.from('audit_log').select('id').limit(1))
}

section('7b. Tinjauan order di Persetujuan')
{
  await expectDenied('staf memutuskan pengajuan lewat API', rani.rpc('decide_approval', { p_request: randomUUID(), p_approve: true }))
  await expectDenied('staf menghapus tanda tinjauan langsung', rani.from('orders').update({ needs_review: false }).eq('admin_id', ids.rani).select('id'))
  await expectDenied('staf membuat pengajuan tinjauan langsung', rani.from('approval_requests').insert({ kind: 'order_review', target_id: randomUUID(), reason: 'palsu' }))
  await expectDenied('staf memanggil fungsi trigger antrean', rani.rpc('_order_review_sync'))
  await expectDenied('pengunjung tanpa login membaca antrean', client().from('approval_requests').select('id').limit(1))
}

// ───────────────────────────────────────────────────────────
section('8. Wajib ganti password setelah reset')
{
  await owner.rpc('revoke_sessions', { p_profile: ids.dimas }) // menandai must_change_password
  const { c: d2, error } = await signIn('dimas')
  if (error) bad('login dimas gagal: ' + error.message)
  else await expectDenied('akun yang wajib ganti password mencatat order lewat API', d2.rpc('record_order', { p_voucher: randomUUID(), p_customer_name: 'x', p_customer_wa: '081234567890', p_ref: null, p_menu_price: 1, p_sell_price: 1, p_extra_cost: 0, p_manual_discount: null, p_price_after_override: null, p_confirm: true, p_idem: randomUUID() }))
  await expectDenied('menandai sudah ganti password tanpa menggantinya', d2.rpc('mark_password_changed'))
  // Ganti password lewat Auth (hash baru), lalu penanda boleh dihapus.
  await d2.auth.updateUser({ password: PASSWORD + '-baru' })
  await expectOk('setelah password diganti, akun bisa dipakai lagi', d2.rpc('mark_password_changed'))
  await d2.auth.updateUser({ password: PASSWORD }) // kembalikan password uji
}

console.log(failed ? `\n${failed} pemeriksaan gagal` : '\nSemua pemeriksaan keamanan lulus')
process.exit(failed ? 1 : 0)
