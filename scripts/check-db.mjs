/* eslint-disable @typescript-eslint/no-unused-expressions */
// Pemeriksa skema tanpa Docker: menjalankan semua migrasi + seed di PGlite (Postgres WASM)
// dengan tiruan minimal skema auth Supabase, lalu menguji aturan akses dan alur utama.
// Jalankan: npm run db:check
// Catatan: ini bukan pengganti `supabase db reset`; Supabase asli tetap harus diuji dengan Docker.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const db = new PGlite({ extensions: { pgcrypto } })

const prelude = `
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, instance_id uuid, aud text, role text, email text unique,
  encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz, confirmation_token text, recovery_token text,
  email_change text, email_change_token_new text, email_change_token_current text, phone_change text,
  phone_change_token text, reauthentication_token text);
create table auth.identities (id uuid primary key, user_id uuid references auth.users, provider_id text,
  identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
-- Tiruan minimal Supabase Storage (bucket & objek; foldername seperti aslinya).
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets,
  name text, owner uuid, owner_id text, metadata jsonb, unique (bucket_id, name));
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to authenticated, service_role;
grant select, insert on storage.objects to authenticated;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
-- Meniru hak default Supabase pada skema public.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`

const ids = { owner: '00000000-0000-4000-8000-000000000001', rani: '00000000-0000-4000-8000-000000000002', dimas: '00000000-0000-4000-8000-000000000003' }
let failed = 0
const ok = (name) => console.log('  ✓ ' + name)
const bad = (name, e) => { failed++; console.log('  ✗ ' + name + (e ? ' — ' + e : '')) }

async function as(user, fn) {
  await db.exec('reset role')
  if (user === 'anon') {
    await db.exec(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false); set role anon`)
  } else {
    await db.exec(`select set_config('request.jwt.claim.sub', '${ids[user]}', false),
                          set_config('request.jwt.claims', '{"sub":"${ids[user]}","role":"authenticated"}', false);
                   set role authenticated`)
  }
  try { return await fn() } finally { await db.exec('reset role') }
}
const q = async (sql, params) => (await db.query(sql, params)).rows
async function expectOk(name, fn) { try { const r = await fn(); ok(name); return r } catch (e) { bad(name, e.message) } }
async function expectFail(name, fn, match) {
  try { await fn(); bad(name, 'seharusnya ditolak') } catch (e) {
    if (match && !e.message.includes(match)) bad(name, 'pesan tak terduga: ' + e.message); else ok(name + ' (ditolak: ' + e.message.slice(0, 70) + ')')
  }
}

console.log('Menjalankan migrasi & seed…')
await db.exec(prelude)
const migDir = join(root, 'supabase/migrations')
for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(migDir, f), 'utf8')); console.log('  ✓ ' + f) } catch (e) { console.log('  ✗ ' + f + ' — ' + e.message); process.exit(1) }
}
try { await db.exec(readFileSync(join(root, 'supabase/seed.sql'), 'utf8')); console.log('  ✓ seed.sql') } catch (e) { console.log('  ✗ seed.sql — ' + e.message); process.exit(1) }

console.log('\nOtorisasi')
await expectFail('anon tidak bisa membaca profil', () => as('anon', () => q('select * from public.profiles')))
await as('rani', async () => {
  const base = await q('select count(*)::int n from public.accounts')
  base[0].n === 0 ? ok('staf tidak membaca tabel akun dasar') : bad('staf membaca tabel akun dasar')
  const list = await q(`select account_number from public.account_list where account_code = 'KK-0192'`)
  list[0]?.account_number?.includes('••••') ? ok('nomor akun VM tersamar untuk staf') : bad('nomor akun tidak tersamar', JSON.stringify(list))
  const dev = await q('select count(*)::int n from public.vm_devices')
  dev[0].n === 0 ? ok('staf tidak melihat virtual device') : bad('staf melihat virtual device')
})
await expectFail('staf ditolak vm_add_account', () => as('rani', () => q(`select public.vm_add_account('VD-04','KK-0300','085770040499',null,'{}',gen_random_uuid())`)), 'khusus owner')
await expectFail('staf tanpa izin ditolak panel_add_account', () => as('dimas', () => q(`select public.panel_add_account('KK','KK-0301',null,null,'{}',gen_random_uuid())`)), 'izin restock')
await expectFail('staf tidak bisa insert langsung ke vouchers', () => as('rani', () => q(`insert into public.vouchers (code) values ('x')`)))
await expectFail('staf tidak bisa mengubah harga kredit', () => as('rani', () => q(`insert into public.credit_prices (rp_per_credit, effective_from) values (1, now())`)))
await expectFail('staf tidak bisa memanggil fungsi internal', () => as('rani', () => q(`select public._create_account('KK','KK-0302','panel',null,null,null,null,'{}',gen_random_uuid())`)))

console.log('\nRestock')
await as('rani', async () => {
  const key = (await q('select gen_random_uuid() k'))[0].k
  const r1 = await expectOk('staf berizin menambah akun lewat Panel', () => q(`select public.panel_add_account('KK','KK-0234',null,null,'{"BP":1}',$1) c`, [key]))
  const r2 = await q(`select public.panel_add_account('KK','KK-0234',null,null,'{"BP":1}',$1) c`, [key])
  r1 && r2[0].c === r1[0].c ? ok('kiriman ganda (idempotensi) mengembalikan restock yang sama') : bad('idempotensi')
  const v = await q(`select string_agg(v.code, ',' order by v.code) c, sum(allocated_cost) total from public.vouchers v join public.account_list a on a.id = v.account_id where a.account_code = 'KK-0234'`)
  v[0].c === 'V-KK0234-A,V-KK0234-B,V-KK0234-BP01,V-KK0234-C' ? ok('A, B, C otomatis + 1 Baperan: ' + v[0].c) : bad('voucher otomatis', v[0].c)
  Number(v[0].total) === 4000 ? ok('modal akun Rp4.000 dicatat sekali dan teralokasi penuh') : bad('alokasi modal', v[0].total)
})
await expectFail('ID akun duplikat ditolak', () => as('rani', () => q(`select public.panel_add_account('KK','KK-0187',null,null,'{}',gen_random_uuid())`)), 'sudah terdaftar')
await expectFail('voucher utama tidak dibuat ulang', () => as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0233'`)
  return q(`select public.add_stock($1, '[{"type":"A","qty":1}]', gen_random_uuid())`, [a[0].id])
}), 'tidak dibuat ulang')
await as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0233'`)
  await expectOk('tambah Baperan ke akun Panel yang ada', () => q(`select public.add_stock($1, '[{"type":"BP","qty":2}]', gen_random_uuid())`, [a[0].id]))
})
await expectFail('staf tidak menambah stok akun VM', () => as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0192'`)
  return q(`select public.add_stock($1, '[{"type":"BP","qty":1}]', gen_random_uuid())`, [a[0].id])
}), 'khusus owner')

console.log('\nID akun fleksibel & restock Baperan terpisah')
await as('rani', async () => {
  await expectOk('ID 6 digit tanpa prefix diterima (195678)', () => q(`select public.panel_add_account('KK','195678',null,null,'{}',gen_random_uuid())`))
  await expectOk('ID 7 digit dengan leading zero diterima (0123456)', () => q(`select public.panel_add_account('KK','0123456',null,null,'{}',gen_random_uuid())`))
  const a = await q(`select account_code from public.account_list where account_code in ('195678','0123456') order by 1`)
  a.map((x) => x.account_code).join(',') === '0123456,195678' ? ok('ID disimpan sebagai teks, leading zero tetap') : bad('ID akun', JSON.stringify(a))
  const v = await q(`select string_agg(code, ',' order by code) c from public.vouchers where code like 'V-KK195678-%'`)
  v[0].c === 'V-KK195678-A,V-KK195678-B,V-KK195678-C' ? ok('voucher utama otomatis untuk ID baru: ' + v[0].c) : bad('voucher ID baru', v[0].c)
})
await expectFail('KK-195678 dianggap akun yang sama dengan 195678', () => as('rani', () => q(`select public.panel_add_account('KK','KK-195678',null,null,'{}',gen_random_uuid())`)), 'sudah terdaftar')
await expectFail('ID terlalu pendek ditolak dengan pesan jelas', () => as('rani', () => q(`select public.panel_add_account('KK','12',null,null,'{}',gen_random_uuid())`)), 'tidak valid')
await expectFail('karakter tidak valid ditolak', () => as('rani', () => q(`select public.panel_add_account('KK','19 56#78',null,null,'{}',gen_random_uuid())`)), 'tidak valid')
const bpType = (await q(`select id from public.voucher_types where brand_id = 'KK' and code = 'BP'`))[0].id
const mainType = (await q(`select id from public.voucher_types where brand_id = 'KK' and code = 'A'`))[0].id
let lotCode
await as('rani', async () => {
  const before = await q(`select count(*)::int n from public.account_list`)
  const r = await expectOk('restock Baperan saja (10 voucher, modal belum diisi)', () => q(`select public.restock_extra_only($1, 10, null, null, 'Beli dari reseller A', current_date, gen_random_uuid()) c`, [bpType]))
  lotCode = r?.[0].c
  const after = await q(`select count(*)::int n from public.account_list`)
  after[0].n === before[0].n ? ok('tidak membuat akun KopKen baru') : bad('akun bertambah')
  const v = await q(`select count(*)::int n, count(*) filter (where allocated_cost is null)::int unknown, count(*) filter (where grp = 'main')::int main
                     from public.vouchers v join public.restocks r on r.id = v.restock_id where r.code = $1`, [lotCode])
  v[0].n === 10 && v[0].unknown === 10 && v[0].main === 0 ? ok('10 Baperan individual, modal "belum diisi" (bukan Rp0), tanpa voucher utama') : bad('lot Baperan', JSON.stringify(v[0]))
})
await expectFail('restock terpisah tidak boleh untuk voucher utama', () => as('rani', () => q(`select public.restock_extra_only($1, 1, null, 0, 'uji', current_date, gen_random_uuid())`, [mainType])), 'voucher tambahan')
await expectFail('sumber pembelian wajib diisi', () => as('rani', () => q(`select public.restock_extra_only($1, 1, null, 0, '', current_date, gen_random_uuid())`, [bpType])), 'sumber')
await expectFail('staf tanpa izin tidak bisa restock Baperan', () => as('dimas', () => q(`select public.restock_extra_only($1, 1, null, 0, 'uji', current_date, gen_random_uuid())`, [bpType])), 'izin')
await expectFail('staf tidak bisa restock Baperan ke akun VM', () => as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0192'`)
  return q(`select public.restock_extra_only($1, 1, $2, 0, 'uji', current_date, gen_random_uuid())`, [bpType, a[0].id])
}), 'khusus owner')
await as('rani', async () => {
  const v = await q(`select v.id from public.vouchers v join public.restocks r on r.id = v.restock_id where r.code = $1 order by v.code limit 1`, [lotCode])
  const c = await q(`select public.record_order($1,'Lot','081234567890',null,30000,25000,0,null,null,true,gen_random_uuid()) c`, [v[0].id])
  const o = await q(`select account_id, allocated_cost, review_reasons from public.orders where code = $1`, [c[0].c])
  o[0].account_id === null && Number(o[0].allocated_cost) === 0 && o[0].review_reasons.includes('Modal voucher belum diisi')
    ? ok('order dari Baperan lepas: tanpa akun, modal Rp0 sementara & ditandai tinjau') : bad('order lot', JSON.stringify(o[0]))
})
await expectFail('staf tidak bisa mengisi modal restock', () => as('rani', async () => {
  const r = await q(`select id from public.restocks where code = $1`, [lotCode]); return q(`select public.set_restock_unit_cost($1, 2000)`, [r[0].id])
}), 'khusus owner')
await as('owner', async () => {
  const r = await q(`select id from public.restocks where code = $1`, [lotCode])
  const n = await expectOk('owner mengisi modal Rp2.000 per voucher', () => q(`select public.set_restock_unit_cost($1, 2000) n`, [r[0].id]))
  n?.[0].n === 10 ? ok('modal tercatat di 10 voucher (termasuk yang sudah terpakai)') : bad('isi modal', JSON.stringify(n))
  const o = await q(`select allocated_cost from public.orders where customer_name = 'Lot'`)
  Number(o[0].allocated_cost) === 0 ? ok('order lama tidak dihitung ulang (snapshot tetap)') : bad('snapshot order berubah')
  await expectFail('modal yang sudah diisi tidak bisa ditimpa', () => q(`select public.set_restock_unit_cost($1, 1)`, [r[0].id]), 'sudah diisi')
})

console.log('\nOrder & voucher')
const vid = async (code) => (await q(`select id from public.vouchers where code = $1`, [code]))[0].id
await expectFail('voucher yang sudah terpakai tidak bisa dipakai lagi', () => as('rani', async () =>
  q(`select public.record_order($1,'X','081234567890',null,58000,39000,0,null,null,true,gen_random_uuid())`, [await vid('V-KK0192-A')])), 'tidak tersedia')
await expectFail('minimum pembelian voucher C divalidasi', () => as('rani', async () =>
  q(`select public.record_order($1,'Nadia','0812-3456-4471',null,58000,39000,0,null,null,true,gen_random_uuid())`, [await vid('V-KK0192-C')])), 'minimum')
await as('rani', async () => {
  const code = await expectOk('order KopKen C Rp76.000 dikonfirmasi', async () => q(`select public.record_order($1,'Nadia Putri','0812-3456-4471','KK-1',76000,52000,2000,null,null,true,gen_random_uuid()) c`, [await vid('V-KK0192-C')]))
  const o = await q(`select discount, price_after_discount, hpp, net_profit, needs_review from public.orders where code = $1`, [code[0].c])
  o[0].discount === 30000 && Number(o[0].hpp) === 47333.33 && !o[0].needs_review
    ? ok('potongan dibatasi Rp30.000; HPP = merchant Rp46.000 + modal Rp1.333,33') : bad('perhitungan order', JSON.stringify(o[0]))
  const vs = await q(`select status from public.vouchers where code = 'V-KK0192-C'`)
  vs[0].status === 'used' ? ok('voucher berubah menjadi Terpakai') : bad('status voucher', vs[0].status)
})
await expectFail('voucher tanpa ketentuan wajib potongan manual', () => as('rani', async () =>
  q(`select public.record_order($1,'Bima','081120203030',null,40000,30000,0,null,null,true,gen_random_uuid())`, [await vid('V-JJ0019-V01')])), 'potongan manual')
await as('rani', async () => {
  const c = await q(`select public.record_order($1,'Bima','081120203030',null,40000,30000,0,15000,null,true,gen_random_uuid()) c`, [await vid('V-JJ0019-V01')])
  const o = await q(`select needs_review from public.orders where code = $1`, [c[0].c])
  o[0].needs_review ? ok('potongan manual menandai order untuk ditinjau owner') : bad('flag tinjau')
})

console.log('\nPembatalan resmi')
await as('rani', async () => {
  const o = await q(`select id from public.orders where customer_name = 'Nadia Putri'`)
  await expectOk('staf mengajukan pembatalan', () => q(`select public.request_order_cancel($1, 'Customer batal sebelum bayar')`, [o[0].id]))
})
await as('owner', async () => {
  const r = await q(`select id from public.approval_requests where kind = 'order_cancel' and status = 'pending'`)
  await expectOk('owner menyetujui pembatalan', () => q(`select public.decide_approval($1, true, 'ok')`, [r[0].id]))
  const v = await q(`select v.status, (select count(*)::int from public.voucher_usages u where u.voucher_id = v.id) n,
                            (select count(*)::int from public.voucher_usages u where u.voucher_id = v.id and u.reversed_at is null) active
                     from public.vouchers v where code = 'V-KK0192-C'`)
  v[0].status === 'available' && v[0].n === 1 && v[0].active === 0 ? ok('voucher kembali Tersedia, histori pemakaian tetap tercatat') : bad('pembatalan', JSON.stringify(v[0]))
})

console.log('\nAbsensi, benefit & payroll')
let shiftId
await as('owner', async () => {
  const c = await q(`select public.add_extra_shift($1, now() - interval '30 minutes', now() + interval '5 hours') c`, [ids.rani])
  shiftId = (await q(`select id from public.shifts where code = $1`, [c[0].c]))[0].id
  ok('owner membuat shift tambahan ' + c[0].c)
  const e = await q(`select count(*)::int n from public.benefit_entitlements where shift_id = $1`, [shiftId])
  e[0].n === 1 ? ok('hak 1 cup KopKen otomatis dibuat untuk shift') : bad('hak benefit')
})
await expectFail('staf lain tidak bisa absen di shift Rani', () => as('dimas', () => q(`select public.attendance_action($1, 'clock_in')`, [shiftId])))
await expectFail('tidak bisa mulai istirahat sebelum absen masuk', () => as('rani', () => q(`select public.attendance_action($1, 'break_start')`, [shiftId])), 'Urutan')
// Bukti receipt: objek di bucket privat, di folder <admin>/<shift>/ milik pengaju.
const receipt = (who, n) => `${ids[who]}/${shiftId}/bukti-${n}.jpg`
const putReceipt = (who, n) => as(who, () => q(`insert into storage.objects (bucket_id, name, owner) values ('benefit-receipts', $1, auth.uid())`, [receipt(who, n)]))
await expectFail('benefit belum bisa diajukan sebelum absen masuk', () => as('rani', async () => {
  await putReceipt('rani', 0); return q(`select public.submit_benefit_claim($1, 'regular', $2)`, [shiftId, receipt('rani', 0)])
}), 'setelah absen masuk')
await expectFail('klaim lama tanpa ukuran & bukti tidak bisa dipakai', () => as('rani', () => q(`select public.claim_benefit($1)`, [shiftId])))
let claimId
await as('rani', async () => {
  await expectOk('absen masuk (waktu server)', () => q(`select public.attendance_action($1, 'clock_in')`, [shiftId]))
  await expectFail('ukuran cup wajib dipilih', () => q(`select public.submit_benefit_claim($1, null, $2)`, [shiftId, receipt('rani', 0)]), 'ukuran cup')
  await expectFail('bukti receipt wajib ada di storage', () => q(`select public.submit_benefit_claim($1, 'large', $2)`, [shiftId, receipt('rani', 9)]), 'receipt')
  const c = await expectOk('ajukan pengambilan (Large + bukti) tanpa memilih petugas', () => q(`select public.submit_benefit_claim($1, 'large', $2) id`, [shiftId, receipt('rani', 0)]))
  claimId = c?.[0].id
  const st = await q(`select status, admin_id from public.benefit_claims where id = $1`, [claimId])
  st[0].status === 'pending' && st[0].admin_id === ids.rani ? ok('status Menunggu Verifikasi, identitas dari sesi') : bad('status klaim', JSON.stringify(st[0]))
  await putReceipt('rani', 1)
  await expectFail('pengajuan kedua saat masih menunggu ditolak', () => q(`select public.submit_benefit_claim($1, 'regular', $2)`, [shiftId, receipt('rani', 1)]), 'sudah diajukan')
})
await expectFail('bukti di folder admin lain ditolak', () => as('dimas', async () => {
  await putReceipt('dimas', 2); return q(`select public.submit_benefit_claim($1, 'regular', $2)`, [shiftId, receipt('dimas', 2)])
}), 'Shift tidak ditemukan')
await expectFail('staf tidak bisa memverifikasi klaim', () => as('rani', () => q(`select public.verify_benefit_claim($1, true, null)`, [claimId])), 'khusus owner')
await as('owner', async () => {
  await expectFail('owner wajib membuka bukti sebelum menyetujui', () => q(`select public.verify_benefit_claim($1, true, null)`, [claimId]), 'Buka dan periksa')
  await expectFail('penolakan wajib beralasan', () => q(`select public.verify_benefit_claim($1, false, '')`, [claimId]), 'Alasan')
  await expectOk('owner menolak dengan alasan', () => q(`select public.verify_benefit_claim($1, false, 'Struk tidak terbaca')`, [claimId]))
  await expectFail('keputusan ganda ditolak', () => q(`select public.verify_benefit_claim($1, false, 'lagi')`, [claimId]), 'sudah diputuskan')
})
await as('rani', async () => {
  const c = await expectOk('setelah ditolak, admin mengajukan ulang (baris baru tercatat)', () => q(`select public.submit_benefit_claim($1, 'regular', $2) id`, [shiftId, receipt('rani', 1)]))
  claimId = c?.[0].id
})
await as('owner', async () => {
  await q(`select public.mark_benefit_receipt_viewed($1)`, [claimId])
  await expectOk('owner menyetujui setelah membuka bukti', () => q(`select public.verify_benefit_claim($1, true, null)`, [claimId]))
  const n = await q(`select count(*) filter (where status = 'rejected')::int rej, count(*) filter (where status = 'verified')::int ver from public.benefit_claims where shift_id = $1`, [shiftId])
  n[0].rej === 1 && n[0].ver === 1 ? ok('klaim ditolak tetap tersimpan; satu klaim terverifikasi') : bad('histori klaim', JSON.stringify(n[0]))
  const a = await q(`select count(*)::int n from public.audit_log where entity = 'benefit_claims'`)
  a[0].n >= 4 ? ok('setiap perubahan status klaim tercatat di audit log') : bad('audit klaim', a[0].n)
})
await expectFail('pengajuan baru setelah terverifikasi ditolak', () => as('rani', async () => {
  await putReceipt('rani', 3); return q(`select public.submit_benefit_claim($1, 'large', $2)`, [shiftId, receipt('rani', 3)])
}), 'sudah diajukan')
await expectFail('absen masuk kedua ditolak', () => as('rani', () => q(`select public.attendance_action($1, 'clock_in')`, [shiftId])), 'Urutan')
await as('rani', async () => {
  await q(`select public.attendance_action($1, 'break_start')`, [shiftId])
  await q(`select public.attendance_action($1, 'break_end')`, [shiftId])
  await expectOk('absen pulang', () => q(`select public.attendance_action($1, 'clock_out')`, [shiftId]))
  const e = await q(`select kind, base_allowance, bonus, status from public.shift_earnings where shift_id = $1`, [shiftId])
  e[0]?.kind === 'extra' && Number(e[0].base_allowance) === 0 && e[0].status === 'pending'
    ? ok('shift tambahan menghasilkan bonus terpisah (pokok Rp0), menunggu persetujuan') : bad('earning', JSON.stringify(e[0]))
})
await expectFail('staf tidak bisa menyetujui earning sendiri', () => as('rani', async () => {
  const e = await q(`select id from public.shift_earnings where shift_id = $1`, [shiftId]); return q(`select public.decide_earning($1, true)`, [e[0].id])
}), 'khusus owner')
await as('owner', async () => {
  const e = await q(`select id from public.shift_earnings where shift_id = $1`, [shiftId])
  await q(`select public.decide_earning($1, true)`, [e[0].id])
  const s = await q(`select shift_date from public.shifts where id = $1`, [shiftId])
  const week = (await q(`select (date_trunc('week', $1::date))::date w`, [s[0].shift_date]))[0].w
  const p = await expectOk('owner membuat rekap mingguan', () => q(`select public.build_weekly_payroll($1, $2) id`, [ids.rani, week]))
  await expectFail('koreksi tanpa alasan ditolak', () => q(`select public.approve_weekly_payroll($1, '[{"amount": -1000}]')`, [p[0].id]), 'alasan')
  await expectOk('owner menyetujui rekap dengan koreksi beralasan', () => q(`select public.approve_weekly_payroll($1, '[{"amount": 1000, "reason": "uji koreksi tambahan"}]')`, [p[0].id]))
  await expectOk('owner menandai dicairkan', () => q(`select public.mark_payroll_paid($1)`, [p[0].id]))
  await expectFail('pencairan kedua ditolak', () => q(`select public.mark_payroll_paid($1)`, [p[0].id]), 'disetujui')
  await expectFail('rekap yang sudah dibayar terkunci', () => q(`select public.build_weekly_payroll($1, $2)`, [ids.rani, week]), 'terkunci')
})
await expectFail('staf tidak bisa membaca audit log', async () => {
  const r = await as('rani', () => q('select count(*)::int n from public.audit_log'))
  if (r[0].n === 0) throw new Error('0 baris terlihat')
})

await expectFail('staf tidak bisa mengubah jadwal', () => as('rani', () =>
  q(`select public.set_schedule($1, '{1,2}', '08:00', '20:00', 60, current_date + 1, 'uji')`, [ids.rani])), 'khusus owner')
await as('owner', async () => {
  const from = (await q(`select (public.jkt_date(now()) + 7) d`))[0].d
  await expectOk('owner mengubah jadwal dengan alasan', () =>
    q(`select public.set_schedule($1, '{2,4,6,7}', '09:00', '21:00', 60, $2, 'tukar hari dengan Dimas')`, [ids.rani, from]))
  const r = await q(`select count(*) filter (where effective_to is null)::int aktif, count(*)::int semua
                     from public.schedule_templates where admin_id = $1`, [ids.rani])
  r[0].aktif === 4 && r[0].semua === 8 ? ok('versi jadwal lama ditutup, bukan dihapus') : bad('histori jadwal', JSON.stringify(r[0]))
  await expectFail('perubahan kedua di tanggal yang sama ditolak', () =>
    q(`select public.set_schedule($1, '{1}', '09:00', '21:00', 60, $2, 'uji ulang')`, [ids.rani, from]), 'Sudah ada')
})

await as('owner', () => q(`select public.revoke_sessions($1)`, [ids.dimas]))
await expectFail('akun wajib ganti password tidak bisa beraksi lewat API', () => as('dimas', () =>
  q(`select public.attendance_action(gen_random_uuid(), 'clock_in')`)), 'ganti password')
await expectFail('tandai sudah ganti password tanpa benar-benar mengganti ditolak', () => as('dimas', () =>
  q(`select public.mark_password_changed()`)), 'belum diganti')
await q(`update auth.users set encrypted_password = extensions.crypt('Password-Baru-2026', extensions.gen_salt('bf')) where id = $1`, [ids.dimas])
await expectOk('setelah password diganti, penanda bisa dihapus', () => as('dimas', () => q(`select public.mark_password_changed()`)))

console.log(failed ? `\n${failed} pemeriksaan gagal` : '\nSemua pemeriksaan lulus')
process.exit(failed ? 1 : 0)
