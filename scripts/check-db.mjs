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
await expectFail('benefit belum bisa diklaim sebelum absen masuk', () => as('rani', () => q(`select public.claim_benefit($1)`, [shiftId])), 'setelah absen masuk')
await as('rani', async () => {
  await expectOk('absen masuk (waktu server)', () => q(`select public.attendance_action($1, 'clock_in')`, [shiftId]))
  await expectOk('klaim benefit tanpa memilih petugas', () => q(`select public.claim_benefit($1)`, [shiftId]))
})
await expectFail('klaim benefit kedua ditolak database', () => as('rani', () => q(`select public.claim_benefit($1)`, [shiftId])), 'sudah diklaim')
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
