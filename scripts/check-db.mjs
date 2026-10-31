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
  const r1 = await expectOk('staf berizin menambah akun lewat Panel', () => q(`select public.panel_add_account('KK','KK-0234',null,null,'{}',$1) c`, [key]))
  const r2 = await q(`select public.panel_add_account('KK','KK-0234',null,null,'{}',$1) c`, [key])
  r1 && r2[0].c === r1[0].c ? ok('kiriman ganda (idempotensi) mengembalikan restock yang sama') : bad('idempotensi')
  const v = await q(`select string_agg(v.code, ',' order by v.code) c, sum(allocated_cost) total from public.vouchers v join public.account_list a on a.id = v.account_id where a.account_code = 'KK-0234'`)
  v[0].c === 'V-KK0234-A,V-KK0234-B,V-KK0234-C' ? ok('A, B, C otomatis: ' + v[0].c) : bad('voucher otomatis', v[0].c)
  Number(v[0].total) === 4000 ? ok('modal akun Rp4.000 dicatat sekali dan teralokasi penuh') : bad('alokasi modal', v[0].total)
})
await expectFail('ID akun duplikat ditolak', () => as('rani', () => q(`select public.panel_add_account('KK','KK-0187',null,null,'{}',gen_random_uuid())`)), 'sudah terdaftar')
await expectFail('voucher utama tidak dibuat ulang', () => as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0233'`)
  return q(`select public.add_stock($1, '[{"type":"A","qty":1}]', gen_random_uuid())`, [a[0].id])
}), 'tidak dibuat ulang')
await expectFail('Baperan tidak bisa ditambahkan ke akun reguler', () => as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0233'`)
  return q(`select public.add_stock($1, '[{"type":"BP","qty":2}]', gen_random_uuid())`, [a[0].id])
}), 'Restock Baperan')
await expectFail('akun reguler baru tidak bisa membawa Baperan', () => as('rani', () =>
  q(`select public.panel_add_account('KK','KK-0235',null,null,'{"BP":1}',gen_random_uuid())`)), 'Restock Baperan')
await db.exec('reset role')
await q(`insert into public.brands (id, name) values ('ZZ', 'Uji Tanpa Modal')`)
await q(`insert into public.voucher_types (brand_id, code, name, grp) values ('ZZ', 'X', 'Uji', 'extra')`)
await q(`insert into public.accounts (brand_id, account_code, source) values ('ZZ', 'ZZ-0001', 'panel')`)
await as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'ZZ-0001'`)
  await expectOk('tambah voucher ke akun brand tanpa modal', () => q(`select public.add_stock($1, '[{"type":"X","qty":2}]', gen_random_uuid())`, [a[0].id]))
  const v = await q(`select count(*)::int n, count(*) filter (where allocated_cost is null)::int unknown from public.vouchers where account_id = $1`, [a[0].id])
  v[0].n === 2 && v[0].unknown === 2 ? ok('modal brand belum dikonfigurasi: voucher "belum diisi" (NULL), bukan Rp0') : bad('modal NULL', JSON.stringify(v[0]))
})
console.log('\nModal per brand (set_brand_cost)')
await expectFail('akun baru ditolak selama modal brand belum dikonfigurasi', () => as('rani', () =>
  q(`select public.panel_add_account('ZZ','ZZ-0002',null,null,'{"X":1}',gen_random_uuid())`)), 'Modal brand')
const today = (await q(`select public.jkt_date(now())::text d`))[0].d
await expectFail('staf tidak bisa mengatur modal brand', () => as('rani', () =>
  q(`select public.set_brand_cost('ZZ','rp_per_voucher',null,1500,$1::date)`, [today])), 'khusus owner')
await expectFail('insert langsung ke brand_costs ditolak (wajib lewat fungsi + audit)', () => as('owner', () =>
  q(`insert into public.brand_costs (brand_id, basis, rp_per_voucher, effective_from) values ('ZZ','rp_per_voucher',1500,now())`)), 'permission denied')
await expectFail('tanggal mulai di masa lalu ditolak', () => as('owner', () =>
  q(`select public.set_brand_cost('ZZ','rp_per_voucher',null,1500,$1::date - 1)`, [today])), 'masa lalu')
await expectFail('kredit per akun 0 ditolak', () => as('owner', () =>
  q(`select public.set_brand_cost('ZZ','credit_per_account',0,null,$1::date)`, [today])), 'jumlah kredit')
await expectFail('Rupiah per voucher tanpa nilai ditolak', () => as('owner', () =>
  q(`select public.set_brand_cost('ZZ','rp_per_voucher',null,null,$1::date)`, [today])), 'per voucher')
await expectFail('Gratis dengan nominal ditolak', () => as('owner', () =>
  q(`select public.set_brand_cost('ZZ','free',null,1500,$1::date)`, [today])), 'Gratis')
await as('owner', async () => {
  await expectOk('owner mengatur Rp1.500 per voucher mulai hari ini', () =>
    q(`select public.set_brand_cost('ZZ','rp_per_voucher',null,1500,$1::date,'uji')`, [today]))
  const a = await q(`select after from public.audit_log where action = 'brand_cost.set' order by id desc limit 1`)
  a[0]?.after.rp_per_voucher === 1500 && a[0]?.after.note === 'uji' ? ok('perubahan modal tercatat di audit log') : bad('audit modal', JSON.stringify(a[0]))
  await expectFail('versi kedua di tanggal yang sama ditolak', () =>
    q(`select public.set_brand_cost('ZZ','free',null,null,$1::date)`, [today]), 'tanggal mulai berlaku yang sama')
  await expectOk('owner menjadwalkan versi berikutnya', () => q(`select public.set_brand_cost('ZZ','free',null,null,$1::date + 7)`, [today]))
})
await as('rani', async () => {
  await expectOk('setelah modal diatur, akun baru tersimpan', () =>
    q(`select public.panel_add_account('ZZ','ZZ-0002',null,null,'{"X":2}',gen_random_uuid())`))
  const v = await q(`select allocated_cost from public.vouchers v join public.account_list a on a.id = v.account_id where a.account_code = 'ZZ-0002'`)
  v.length === 2 && v.every((x) => Number(x.allocated_cost) === 1500) ? ok('restock memakai modal yang berlaku (Rp1.500 per voucher), bukan versi terjadwal') : bad('modal restock', JSON.stringify(v))
})
await expectFail('staf tidak menambah stok akun VM', () => as('rani', async () => {
  const a = await q(`select id from public.account_list where account_code = 'KK-0192'`)
  return q(`select public.add_stock($1, '[{"type":"A","qty":1}]', gen_random_uuid())`, [a[0].id])
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
const xType = (await q(`select id from public.voucher_types where brand_id = 'ZZ' and code = 'X'`))[0].id
await expectFail('Baperan lepas (tanpa akun) tidak lagi dibuat', () => as('rani', () =>
  q(`select public.restock_extra_only($1, 1, null, null, 'Reseller A', current_date, gen_random_uuid())`, [bpType])), 'Restock Baperan')
let lotCode
await as('rani', async () => {
  const before = await q(`select count(*)::int n from public.account_list`)
  const r = await expectOk('restock voucher tambahan saja (10 voucher, modal belum diisi)', () => q(`select public.restock_extra_only($1, 10, null, null, 'Beli dari reseller A', current_date, gen_random_uuid()) c`, [xType]))
  lotCode = r?.[0].c
  const after = await q(`select count(*)::int n from public.account_list`)
  after[0].n === before[0].n ? ok('tidak membuat akun KopKen baru') : bad('akun bertambah')
  const v = await q(`select count(*)::int n, count(*) filter (where allocated_cost is null)::int unknown, count(*) filter (where grp = 'main')::int main
                     from public.vouchers v join public.restocks r on r.id = v.restock_id where r.code = $1`, [lotCode])
  v[0].n === 10 && v[0].unknown === 10 && v[0].main === 0 ? ok('10 voucher individual, modal "belum diisi" (bukan Rp0), tanpa voucher utama') : bad('lot tambahan', JSON.stringify(v[0]))
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
  const c = await q(`select public.record_order($1,'Lot','081234567890',null,30000,25000,0,5000,null,true,gen_random_uuid()) c`, [v[0].id])
  const o = await q(`select account_id, allocated_cost, review_reasons from public.orders where code = $1`, [c[0].c])
  o[0].account_id === null && Number(o[0].allocated_cost) === 0 && o[0].review_reasons.includes('Modal voucher belum diisi')
    ? ok('order dari voucher lepas: tanpa akun, modal Rp0 sementara & ditandai tinjau') : bad('order lot', JSON.stringify(o[0]))
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

console.log('\nBulk restock')
{
  const rows = (arr) => JSON.stringify(arr)
  const val = await as('rani', () => q(`select public.bulk_restock_validate('panel', 'new_account', 'KK', $1::jsonb) v`, [rows([
    { line: 1, code: '300001', items: { A: 1, B: 1, C: 1 } },
    { line: 2, code: '300002', items: {} },
    { line: 3, code: '300001', items: {} },
    { line: 4, code: 'KK-0142', items: {} },
    { line: 5, code: '300003', items: { A: 2 } },
    { line: 6, code: '300004', items: { X: 1 } },
    { line: 7, code: '30#4', items: {} },
  ])]))
  const v = val[0].v
  const st = v.map((r) => (r.ok ? 'ok' : r.error.slice(0, 24)))
  v[0].ok && v[0].total === 3 && v[1].ok && v[1].total === 3 && !v[2].ok && !v[3].ok && !v[4].ok && !v[5].ok && !v[6].ok
    ? ok('preview: valid, duplikat batch, sudah terdaftar, A=2 ditolak, jenis asing, ID salah — ' + st.join(' | '))
    : bad('validasi bulk', JSON.stringify(st))
  const before = (await q(`select count(*)::int n from public.vouchers`))[0].n
  await expectFail('batch dengan baris tidak valid tidak disimpan sama sekali', () => as('rani', () =>
    q(`select public.bulk_restock('panel','new_account','KK',$1::jsonb,null,null,gen_random_uuid())`, [rows([{ line: 1, code: '300011', items: {} }, { line: 2, code: 'KK-0142', items: {} }])])), 'Baris 2')
  const mid = (await q(`select count(*)::int n from public.vouchers`))[0].n
  mid === before && (await q(`select count(*)::int n from public.account_list where account_code = '300011'`))[0].n === 0
    ? ok('atomik: tidak ada akun/voucher tersisa dari batch gagal') : bad('batch gagal meninggalkan data')
  const key = (await q('select gen_random_uuid() k'))[0].k
  const ok1 = await expectOk('bulk Panel: 3 akun baru (A,B,C otomatis)', () => as('rani', () =>
    q(`select public.bulk_restock('panel','new_account','KK',$1::jsonb,null,null,$2) r`, [rows([
      { line: 1, code: '300001', items: {} }, { line: 2, code: '300002', items: {} }, { line: 3, code: 'KK-3000003', items: {} }]), key])))
  const r1 = ok1?.[0].r
  r1?.new_accounts === 3 && r1?.vouchers === 9 && Number(r1?.total_cost) === 12000
    ? ok(`batch ${r1.batch}: 3 akun, 9 voucher, modal Rp12.000 (1 kredit/akun, bukan per voucher)`) : bad('ringkasan batch', JSON.stringify(r1))
  const again = await as('rani', () => q(`select public.bulk_restock('panel','new_account','KK',$1::jsonb,null,null,$2) r`, [rows([{ line: 1, code: '300009', items: {} }]), key]))
  again[0].r.repeated && again[0].r.batch === r1?.batch ? ok('kiriman ganda mengembalikan batch yang sama, tidak menyimpan ulang') : bad('idempotensi batch')
  const perRow = (r1?.rows ?? []).map((x) => `${x.account_key}:${x.vouchers}`).sort().join(',')
  perRow === ['300001:3', '300002:3', '3000003:3'].sort().join(',') ? ok('hasil per akun dikembalikan: ' + perRow) : bad('hasil per akun', JSON.stringify(r1?.rows))
  JSON.stringify(again[0].r.rows) === JSON.stringify(r1?.rows) ? ok('kiriman ganda mengembalikan hasil per akun yang sama') : bad('hasil per akun saat kiriman ganda')
  await as('rani', async () => {
    await expectFail('bulk tidak bisa menambah Baperan ke akun reguler', () =>
      q(`select public.bulk_restock('panel','add_stock','KK',$1::jsonb,null,null,gen_random_uuid()) r`, [rows([{ line: 1, code: '300001', items: { BP: 3 } }])]), 'Restock Baperan')
    await expectFail('mode tambah voucher tidak membuat ulang voucher utama', () =>
      q(`select public.bulk_restock('panel','add_stock','KK',$1::jsonb,null,null,gen_random_uuid())`, [rows([{ line: 1, code: '300001', items: { A: 1 } }])]), 'tidak dibuat ulang')
    await expectFail('bulk tidak bisa membuat Baperan lepas', () =>
      q(`select public.bulk_restock('panel','extra_only','KK',$1::jsonb,null,'Reseller B',gen_random_uuid()) r`, [rows([{ line: 1, code: null, items: { BP: 5 } }])]), 'Restock Baperan')
  })
  await expectFail('staf tanpa izin tidak bisa bulk Panel', () => as('dimas', () => q(`select public.bulk_restock_validate('panel','new_account','KK','[{"line":1,"code":"399999","items":{}}]')`)), 'izin')
  await expectFail('staf tidak bisa bulk Virtual Machine', () => as('rani', () => q(`select public.bulk_restock_validate('vm','new_account',null,'[{"line":1,"device":"VD-01","code":"399999","number":"081299990001","items":{}}]')`)), 'khusus owner')
  await expectFail('staf tidak bisa menambah stok akun VM lewat bulk Panel', () => as('rani', () =>
    q(`select public.bulk_restock('panel','add_stock','KK','[{"line":1,"code":"KK-0192","items":{"BP":1}}]',null,null,gen_random_uuid())`)), 'Virtual Machine')
  await as('owner', async () => {
    const r = await expectOk('owner bulk VM: device VM-01 dibaca sebagai VD-01, nomor wajib', () =>
      q(`select public.bulk_restock('vm','new_account',null,$1::jsonb,null,null,gen_random_uuid()) r`, [rows([
        { line: 1, device: 'VM-01', code: '400001', number: '0857-9000-0001', items: {} },
        { line: 2, device: 'VD-02', code: '400002', number: '085790000002', items: {} }])]))
    const a = await q(`select account_code, vm_device_id, source from public.accounts where account_code in ('400001','400002') order by 1`)
    r && a.length === 2 && a[0].vm_device_id === 'VD-01' && a.every((x) => x.source === 'vm') ? ok('2 akun VM dibuat di device masing-masing') : bad('bulk VM', JSON.stringify(a))
    const v = await q(`select public.bulk_restock_validate('vm','new_account',null,$1::jsonb) v`, [rows([
      { line: 1, device: 'VD-01', code: '400003', number: '', items: {} },
      { line: 2, device: 'VD-99', code: '400004', number: '085790000004', items: {} },
      { line: 3, device: 'VD-01', code: '400005', number: '0857-9000-0001', items: {} }])])
    const e = v[0].v.map((x) => x.error ?? 'ok')
    e[0].includes('Nomor akun VM wajib') && e[1].includes('tidak ada') && e[2].includes('sudah dipakai') ? ok('VM: nomor wajib, device harus ada, nomor unik') : bad('validasi VM', JSON.stringify(e))
    const b = await q(`select count(*)::int n from public.restock_batches`)
    b[0].n >= 2 ? ok('riwayat batch tersimpan (' + b[0].n + ' batch)') : bad('riwayat batch')
  })
  await as('rani', async () => {
    const vis = await q(`select source from public.restock_batches`)
    vis.length && vis.every((x) => x.source === 'panel') ? ok('staf hanya melihat batch Panel, bukan batch VM') : bad('RLS batch', JSON.stringify(vis))
  })
}

console.log('\nInventaris Baperan terpisah')
{
  const bp = (args) => q(`select public.restock_baperan($1,$2,$3,$4::date,$5::date,$6,$7) r`, args)
  const key = (await q('select gen_random_uuid() k'))[0].k
  const r = await expectOk('staf berizin restock Baperan: nomor + PIN + masa aktif', () => as('rani', () =>
    bp(['+62 812-5550-0099', '4321', 3500, today, '2026-12-31', 'Reseller C', key])))
  const res = r?.[0].r
  const again = await as('rani', () => bp(['081255500099', '4321', 3500, today, '2026-12-31', 'Reseller C', key]))
  again[0].r.repeated && again[0].r.account === res?.account ? ok('kiriman ganda mengembalikan restock yang sama') : bad('idempotensi Baperan', JSON.stringify(again[0].r))
  const acc = (await q(`select a.*, (select count(*)::int from public.vouchers v where v.account_id = a.id) n,
                          (select string_agg(v.code || ':' || coalesce(v.allocated_cost::text, 'null') || ':' || v.grp, ',') from public.vouchers v where v.account_id = a.id) vs,
                          (select unit_cost from public.restocks r where r.account_id = a.id) cost
                        from public.accounts a where account_number = '081255500099'`))[0]
  acc && /^BP-\d{4}$/.test(acc.account_code) && acc.inventory === 'baperan' && acc.n === 1 && acc.pin === '4321' && acc.active_until.toISOString?.().slice(0, 10) !== undefined
    ? ok(`akun ${acc.account_code} (ID otomatis), tepat 1 voucher: ${acc.vs}`) : bad('akun Baperan', JSON.stringify(acc))
  Number(acc?.cost) === 3500 ? ok('modal restock tercatat Rp3.500') : bad('modal Baperan', acc?.cost)
  await expectFail('nomor yang sama tidak bisa jadi dua akun', () => as('rani', () => bp(['0812-5550-0099', null, null, today, '2026-12-31', 'Reseller C', crypto.randomUUID()])), 'sudah terdaftar')
  await expectFail('masa aktif wajib', () => as('rani', () => bp(['081255500098', null, null, today, null, 'Reseller C', crypto.randomUUID()])), 'wajib')
  await expectFail('masa aktif tidak boleh sebelum tanggal restock', () => as('rani', () => bp(['081255500098', null, null, today, '2020-01-01', 'Reseller C', crypto.randomUUID()])), 'sebelum tanggal restock')
  await expectFail('PIN harus 4–8 angka', () => as('rani', () => bp(['081255500098', '12a', null, today, '2026-12-31', 'Reseller C', crypto.randomUUID()])), 'PIN')
  await expectFail('nomor telepon tidak valid ditolak', () => as('rani', () => bp(['12345', null, null, today, '2026-12-31', 'Reseller C', crypto.randomUUID()])), 'tidak valid')
  await expectFail('staf tanpa izin tidak bisa restock Baperan', () => as('dimas', () => bp(['081255500098', null, null, today, '2026-12-31', 'Reseller C', crypto.randomUUID()])), 'izin')
  await expectFail('akun Baperan tidak bisa ditambah voucher kedua', () => as('owner', () =>
    q(`select public.add_stock($1, '[{"type":"BP","qty":1}]', gen_random_uuid())`, [acc.id])), 'tepat 1 voucher')
  await as('rani', async () => {
    const l = await q(`select account_number, pin, inventory from public.account_list where id = $1`, [acc.id])
    l[0]?.account_number === '081255500099' && l[0]?.pin === null && l[0]?.inventory === 'baperan'
      ? ok('staf melihat nomor Baperan utuh, PIN tidak terlihat') : bad('tampilan staf', JSON.stringify(l[0]))
    const raw = await q(`select pin from public.accounts where id = $1`, [acc.id])
    raw.length === 0 ? ok('staf tidak bisa membaca PIN dari tabel akun') : bad('PIN bocor', JSON.stringify(raw))
    const vm = await q(`select account_number from public.account_list where account_code = 'KK-0192'`)
    vm[0]?.account_number !== '085770020201' ? ok('nomor akun VM tetap disamarkan untuk staf') : bad('nomor VM terbuka')
  })
  await as('owner', async () => {
    const l = await q(`select pin from public.account_list where id = $1`, [acc.id])
    l[0]?.pin === '4321' ? ok('owner melihat PIN') : bad('PIN owner', JSON.stringify(l[0]))
    const a = await q(`select after::text t from public.audit_log where action = 'restock.baperan' and entity_id = $1`, [acc.id])
    a.length === 1 && !a[0].t.includes('4321') && a[0].t.includes('"pin_set": true') ? ok('restock tercatat di audit tanpa nilai PIN') : bad('audit Baperan', JSON.stringify(a))
  })
  // Kedaluwarsa: akun seed 0812-5550-0003 aktif s/d kemarin.
  const expired = (await q(`select a.id, v.id vid from public.accounts a join public.vouchers v on v.account_id = a.id where a.account_number = '081255500003'`))[0]
  await expectFail('voucher dari akun Baperan kedaluwarsa tidak bisa dipakai', () => as('rani', () =>
    q(`select public.record_order($1,'Uji','081234567890',null,30000,25000,0,null,null,true,gen_random_uuid())`, [expired.vid])), 'kedaluwarsa')
  await expectFail('juga tidak bisa dijadikan draft', () => as('rani', () =>
    q(`select public.record_order($1,'Uji','081234567890',null,30000,25000,0,null,null,false,gen_random_uuid())`, [expired.vid])), 'kedaluwarsa')
  const still = await q(`select (select count(*)::int from public.accounts where id = $1) a, (select status from public.vouchers where id = $2) s`, [expired.id, expired.vid])
  still[0].a === 1 && still[0].s === 'available' ? ok('akun & voucher kedaluwarsa tidak dihapus otomatis') : bad('kedaluwarsa', JSON.stringify(still[0]))
  const activeVid = (await q(`select id from public.vouchers where account_id = $1`, [acc?.id]))[0]?.id
  await as('rani', async () => {
    const o = await expectOk('voucher Baperan aktif bisa dipakai (potongan Rp8.000)', () =>
      q(`select public.record_order($1,'Uji BP','081234567890',null,30000,25000,0,null,null,true,gen_random_uuid()) c`, [activeVid]))
    const d = o && (await q(`select discount, allocated_cost from public.orders where code = $1`, [o[0].c]))[0]
    d && d.discount === 8000 && Number(d.allocated_cost) === 3500 ? ok('order memakai potongan Rp8.000 dan modal Rp3.500') : bad('order Baperan', JSON.stringify(d))
  })
  await expectFail('staf tidak bisa mengubah masa aktif / PIN', () => as('rani', () =>
    q(`select public.owner_update_baperan($1, '2027-01-31', null, 'perpanjang')`, [expired.id])), 'khusus owner')
  await expectFail('perubahan wajib beralasan', () => as('owner', () =>
    q(`select public.owner_update_baperan($1, '2027-01-31', null, '')`, [expired.id])), 'alasan')
  await as('owner', async () => {
    await expectOk('owner memperpanjang masa aktif dengan alasan', () => q(`select public.owner_update_baperan($1, '2027-01-31', '9876', 'diperpanjang reseller')`, [expired.id]))
    const a = await q(`select before, after from public.audit_log where action = 'account.baperan_update' and entity_id = $1`, [expired.id])
    a.length === 1 && a[0].after.active_until === '2027-01-31' && a[0].after.pin_changed === true && !JSON.stringify(a[0]).includes('9876')
      ? ok('perubahan tercatat (sebelum/sesudah, tanpa nilai PIN)') : bad('audit perubahan', JSON.stringify(a))
  })
  await expectOk('setelah diperpanjang, voucher bisa dipakai lagi', () => as('rani', () =>
    q(`select public.record_order($1,'Uji','081234567890',null,30000,25000,0,null,null,false,gen_random_uuid())`, [expired.vid])))
}

console.log('\nBulk Restock Baperan & ketentuan Rp17.000')
{
  const rows = (arr) => JSON.stringify(arr)
  await expectOk('restock satu akun tanpa sumber pembelian', () => as('rani', () =>
    q(`select public.restock_baperan('081255500120', null, null, $1::date, '2026-12-31', null, gen_random_uuid())`, [today])))
  const val = await as('rani', () => q(`select public.bulk_restock_baperan_validate($1::jsonb) v`, [rows([
    { line: 1, number: '0812-5550-0201', pin: '123456' },
    { line: 2, number: '081255500202', pin: '' },
    { line: 3, number: '081255500201', pin: null },
    { line: 4, number: '081255500001', pin: null },
    { line: 5, number: '12345', pin: null },
    { line: 6, number: '081255500206', pin: '12' },
  ])]))
  const st = val[0].v.map((r) => (r.ok ? 'ok' : r.error.slice(0, 22)))
  const v = val[0].v
  v[0].ok && v[1].ok && !v[2].ok && !v[3].ok && !v[4].ok && !v[5].ok && v[0].pin_set === true && v[1].pin_set === false && !JSON.stringify(v).includes('123456')
    ? ok('preview: valid, PIN kosong boleh, duplikat batch, sudah terdaftar, nomor & PIN salah ditolak; nilai PIN tidak dikembalikan — ' + st.join(' | '))
    : bad('validasi bulk Baperan', JSON.stringify(st))
  await expectFail('batch dengan baris tidak valid ditolak seluruhnya', () => as('rani', () =>
    q(`select public.bulk_restock_baperan($1::jsonb, '2026-12-31', $2::date, 3000, null, gen_random_uuid())`, [rows([{ line: 1, number: '081255500211', pin: null }, { line: 2, number: '081255500001', pin: null }]), today])), 'Baris 2')
  ;(await q(`select count(*)::int n from public.accounts where account_number = '081255500211'`))[0].n === 0 ? ok('atomik: tidak ada akun tersisa dari batch gagal') : bad('batch gagal meninggalkan data')
  await expectFail('masa aktif wajib untuk batch', () => as('rani', () =>
    q(`select public.bulk_restock_baperan($1::jsonb, null, $2::date, null, null, gen_random_uuid())`, [rows([{ line: 1, number: '081255500212', pin: null }]), today])), 'wajib')
  await expectFail('staf tanpa izin tidak bisa bulk Baperan', () => as('dimas', () =>
    q(`select public.bulk_restock_baperan_validate($1::jsonb)`, [rows([{ line: 1, number: '081255500213', pin: null }])])), 'izin')
  const key = (await q('select gen_random_uuid() k'))[0].k
  const body = rows([{ line: 1, number: '0812-5550-0221', pin: '1111' }, { line: 2, number: '081255500222', pin: '' }, { line: 3, number: '081255500223', pin: null }])
  const r = await expectOk('bulk Baperan: 3 akun, masa aktif & modal sekali untuk batch', () => as('rani', () =>
    q(`select public.bulk_restock_baperan($1::jsonb, '2026-12-31', $2::date, 3000, 'Reseller D', $3) r`, [body, today, key])))
  const res = r?.[0].r
  res?.new_accounts === 3 && res?.vouchers === 3 && Number(res?.total_cost) === 9000 && res?.rows.length === 3
    ? ok(`batch ${res.batch}: 3 akun, 3 voucher, modal Rp9.000, hasil per baris tersedia`) : bad('ringkasan bulk Baperan', JSON.stringify(res))
  const again = await as('rani', () => q(`select public.bulk_restock_baperan($1::jsonb, '2026-12-31', $2::date, 3000, 'Reseller D', $3) r`, [body, today, key]))
  const n = (await q(`select count(*)::int n from public.accounts where account_number in ('081255500221','081255500222','081255500223')`))[0].n
  again[0].r.repeated && again[0].r.batch === res?.batch && n === 3 ? ok('kiriman ganda mengembalikan batch yang sama, tanpa akun ganda') : bad('idempotensi bulk Baperan', JSON.stringify(again[0].r))
  const acc = await q(`select a.inventory, a.pin, a.active_until::text u, (select count(*)::int from public.vouchers v where v.account_id = a.id) nv,
                        (select batch_id is not null from public.restocks rs where rs.account_id = a.id) in_batch
                       from public.accounts a where account_number in ('081255500221','081255500222') order by account_number`)
  acc[0].inventory === 'baperan' && acc[0].pin === '1111' && acc[1].pin === null && acc.every((x) => x.nv === 1 && x.u === '2026-12-31' && x.in_batch)
    ? ok('setiap nomor = 1 akun Baperan, 1 voucher, masa aktif batch, tercatat di riwayat batch') : bad('akun bulk Baperan', JSON.stringify(acc))
  const b = await as('rani', () => q(`select mode, source from public.restock_batches where code = $1`, [res?.batch]))
  b[0]?.mode === 'baperan' && b[0]?.source === 'panel' ? ok('riwayat batch terlihat staf (mode baperan)') : bad('batch Baperan', JSON.stringify(b))

  // Nomor telepon: angka 0 yang hilang dikembalikan.
  const noZero = await as('rani', () => q(`select public.bulk_restock_baperan_validate($1::jsonb) v`, [rows([{ line: 1, number: '81255500231', pin: null }])]))
  noZero[0].v[0].ok && noZero[0].v[0].number === '081255500231' ? ok('nomor tanpa angka 0 di depan dinormalkan') : bad('normalisasi nomor', JSON.stringify(noZero[0].v))

  // Metode ID Akun
  const idVal = await as('rani', () => q(`select public.bulk_restock_baperan_validate($1::jsonb) v`, [rows([
    { line: 1, account_id: '197865' },
    { line: 2, account_id: 'BP-197866' },
    { line: 3, account_id: 'bp197867' },
    { line: 4, account_id: '197865' },
    { line: 5, account_id: 'BP-197866' },
    { line: 6, account_id: 'abc123' },
    { line: 7, account_id: '081234567890' },
    { line: 8, account_id: '197868', pin: '1234' },
    { line: 9, account_id: '12' },
  ])]))
  const iv = idVal[0].v
  const codes = iv.slice(0, 3).map((x) => x.code).join(',')
  iv.slice(0, 3).every((x) => x.ok && x.number === null && x.counts.BP === 1) && codes === 'BP-197865,BP-197866,BP-197867'
    ? ok('preview ID: prefix ditambahkan sekali, ' + codes) : bad('preview ID akun', JSON.stringify(iv.slice(0, 3)))
  ;/duplikat/.test(iv[3].error) && /duplikat/.test(iv[4].error) ? ok('ID ganda di batch ditolak, juga bila salah satunya berprefix') : bad('duplikat ID', JSON.stringify(iv.slice(3, 5)))
  !iv[5].ok && /angka/.test(iv[5].error) && !iv[8].ok ? ok('ID bukan angka atau terlalu pendek ditolak') : bad('format ID', JSON.stringify([iv[5], iv[8]]))
  ;/nomor telepon/i.test(iv[6].error) ? ok('nomor telepon di mode ID ditolak dengan alasan jelas') : bad('telepon di mode ID', JSON.stringify(iv[6]))
  ;/tidak memakai PIN/.test(iv[7].error) ? ok('PIN di mode ID ditolak') : bad('PIN di mode ID', JSON.stringify(iv[7]))

  const idKey = (await q('select gen_random_uuid() k'))[0].k
  const idBody = rows([{ line: 3, account_id: '197865' }, { line: 7, account_id: 'BP-197866' }])
  const idR = await expectOk('bulk ID: 2 akun tersimpan', () => as('rani', () =>
    q(`select public.bulk_restock_baperan($1::jsonb, '2026-12-31', $2::date, 2500, 'Reseller E', $3) r`, [idBody, today, idKey])))
  const ir = idR?.[0].r
  ir?.rows?.map((x) => `${x.line}:${x.account}`).join() === '3:BP-197865,7:BP-197866' && Number(ir?.total_cost) === 5000
    ? ok('hasil per baris cocok dengan nomor baris, modal Rp5.000') : bad('hasil bulk ID', JSON.stringify(ir))
  const idAgain = await as('rani', () => q(`select public.bulk_restock_baperan($1::jsonb, '2026-12-31', $2::date, 2500, 'Reseller E', $3) r`, [idBody, today, idKey]))
  idAgain[0].r.repeated && idAgain[0].r.rows.length === 2 ? ok('kiriman ganda ID: batch sama, hasil per baris tetap ada') : bad('idempotensi ID', JSON.stringify(idAgain[0].r))
  const ia = await q(`select a.account_code, a.account_number, a.pin, a.inventory, v.code vc, v.status::text st, v.allocated_cost c
                      from public.accounts a join public.vouchers v on v.account_id = a.id where a.account_code in ('BP-197865','BP-197866') order by 1`)
  ia.length === 2 && ia.every((x) => x.account_number === null && x.pin === null && x.inventory === 'baperan' && x.st === 'available' && Number(x.c) === 2500) && ia[0].vc === 'V-KKBP197865-BP01'
    ? ok('akun ID tanpa nomor & PIN, tepat 1 voucher, ' + ia[0].vc) : bad('akun ID', JSON.stringify(ia))
  const dupId = await as('rani', () => q(`select public.bulk_restock_baperan_validate($1::jsonb) v`, [rows([{ line: 1, account_id: '197865' }, { line: 2, account_id: 'BP-197865' }])]))
  dupId[0].v.every((x) => !x.ok) && /sudah terdaftar/.test(dupId[0].v[0].error) ? ok('ID yang sudah tersimpan ditolak: ' + dupId[0].v[0].error) : bad('ID terdaftar', JSON.stringify(dupId[0].v))
  await expectFail('ID terdaftar tidak bisa disimpan lewat kiriman baru', () => as('rani', () =>
    q(`select public.bulk_restock_baperan($1::jsonb, '2026-12-31', $2::date, null, null, gen_random_uuid())`, [rows([{ line: 1, account_id: '197865' }]), today])), 'sudah terdaftar')
  await expectFail('database menolak akun ber-ID dengan PIN', () => q(`update public.accounts set pin = '1234' where account_code = 'BP-197865'`), 'accounts_source_fields')
  await expectFail('database menolak akun Baperan tanpa nomor dengan kode bebas', () => q(`update public.accounts set account_number = null where account_code = 'BP-0001'`), 'accounts_source_fields')
  const idAcc = (await q(`select id from public.accounts where account_code = 'BP-197865'`))[0].id
  await expectFail('owner tidak bisa memberi PIN ke akun ber-ID', () => as('owner', () =>
    q(`select public.owner_update_baperan($1, '2027-01-31', '1234', 'uji pin')`, [idAcc])), 'tidak memakai PIN')
  await expectOk('owner memperpanjang akun ber-ID', () => as('owner', () => q(`select public.owner_update_baperan($1, '2027-01-31', null, 'perpanjang')`, [idAcc])))
  const idVoucher = (await q(`select id from public.vouchers where account_id = $1`, [idAcc]))[0].id
  await as('rani', async () => {
    const o = await expectOk('voucher akun ber-ID bisa dipakai untuk order (potongan Rp8.000)', () =>
      q(`select public.record_order($1,'Uji BP ID','081234567890',null,30000,25000,0,null,null,true,gen_random_uuid()) c`, [idVoucher]))
    const d = o && (await q(`select discount, allocated_cost from public.orders where code = $1`, [o[0].c]))[0]
    d && d.discount === 8000 && Number(d.allocated_cost) === 2500 ? ok('order akun ber-ID: potongan Rp8.000, modal Rp2.500') : bad('order akun ID', JSON.stringify(d))
  })
  const idList = await as('rani', () => q(`select account_code, account_number, pin from public.account_list where id = $1`, [idAcc]))
  idList[0]?.account_code === 'BP-197865' && idList[0]?.account_number === null ? ok('staf melihat akun ber-ID di daftar') : bad('view ID', JSON.stringify(idList))
  // Ketentuan: potongan Rp8.000, minimum pembelian Rp17.000.
  const bv = (await q(`select v.id from public.vouchers v join public.accounts a on a.id = v.account_id where a.account_number = '081255500222'`))[0].id
  await expectFail('order Baperan di bawah Rp17.000 ditolak', () => as('rani', () =>
    q(`select public.record_order($1,'Uji','081234567890',null,16000,12000,0,null,null,true,gen_random_uuid())`, [bv])), 'minimum')
  const o = await expectOk('order Baperan Rp17.000 diterima', () => as('rani', () =>
    q(`select public.record_order($1,'Uji','081234567890',null,17000,12000,0,null,null,true,gen_random_uuid()) c`, [bv])))
  const d = o && (await q(`select discount, rule_snapshot->>'min_purchase' m from public.orders where code = $1`, [o[0].c]))[0]
  d?.discount === 8000 && d?.m === '17000' ? ok('potongan Rp8.000, snapshot minimum Rp17.000 tersimpan di order') : bad('ketentuan Baperan', JSON.stringify(d))
}

console.log('\nProfil sesi & jumlah otomatis per akun')
await as('rani', async () => {
  const p = await q(`select * from public.current_profile()`)
  p.length === 1 && p[0].id === ids.rani && p[0].role === 'staff' ? ok('current_profile hanya mengembalikan profil sendiri') : bad('current_profile', JSON.stringify(p))
})
await as('anon', async () => {
  const r = await q(`select * from public.current_profile()`).catch((e) => e)
  r instanceof Error || r.length === 0 ? ok('anon tidak mendapat profil') : bad('current_profile anon', JSON.stringify(r))
})
const fr = (await q(`select id from public.voucher_types where brand_id = 'FR' and code = 'D25'`))[0].id
const kkBp = (await q(`select id from public.voucher_types where brand_id = 'KK' and code = 'BP'`))[0].id
await expectFail('staf tidak bisa mengubah jumlah otomatis', () => as('rani', () => q(`select public.set_voucher_type_auto($1, 1)`, [fr])), 'khusus owner')
await expectFail('voucher tambahan (Baperan) tidak bisa dibuat otomatis', () => as('owner', () => q(`select public.set_voucher_type_auto($1, 1)`, [kkBp])), 'hanya untuk voucher utama')
await expectFail('jumlah otomatis di luar 1–10 ditolak', () => as('owner', () => q(`select public.set_voucher_type_auto($1, 0)`, [fr])), '1–10')
await as('owner', async () => {
  await expectOk('owner mengatur FR D25 otomatis 1 per akun', () => q(`select public.set_voucher_type_auto($1, 1)`, [fr]))
  const a = await q(`select after from public.audit_log where action = 'voucher_type.set_auto' order by id desc limit 1`)
  a[0]?.after.auto_per_account === 1 ? ok('perubahan jumlah otomatis tercatat di audit log') : bad('audit auto', JSON.stringify(a[0]))
})
await as('rani', async () => {
  await expectOk('ID saja: akun FR baru otomatis mendapat D25', () => q(`select public.panel_add_account('FR','FR-5001',null,null,'{}',gen_random_uuid())`))
  const v = await q(`select string_agg(code, ',') c from public.vouchers where code like 'V-FR5001-%'`)
  v[0].c === 'V-FR5001-D25' ? ok('voucher otomatis dari konfigurasi: ' + v[0].c) : bad('auto FR', v[0].c)
})

console.log('\nTandai dipakai & batalkan pemakaian')
const usedOrder = await as('rani', async () => {
  const v = (await q(`select id from public.vouchers where code = 'V-FR5001-D25'`))[0].id
  const c = (await q(`select public.record_order($1,'Uji','081234567890',null,40000,30000,0,null,null,true,gen_random_uuid()) c`, [v]))[0].c
  await expectFail('voucher yang sama tidak bisa dipakai dua kali', () =>
    q(`select public.record_order($1,'Uji 2','081234567891',null,40000,30000,0,null,null,true,gen_random_uuid())`, [v]), 'tidak tersedia')
  return (await q(`select id from public.orders where code = $1`, [c]))[0].id
})
await expectFail('staf tidak bisa membatalkan pemakaian langsung', () => as('rani', () => q(`select public.cancel_order_now($1, 'salah klik')`, [usedOrder])), 'khusus owner')
await expectFail('pembatalan langsung wajib beralasan', () => as('owner', () => q(`select public.cancel_order_now($1, '')`, [usedOrder])), 'alasan')
await as('owner', async () => {
  await expectOk('owner membatalkan pemakaian dengan alasan', () => q(`select public.cancel_order_now($1, 'salah klik')`, [usedOrder]))
  const r = await q(`select o.status, v.status vstatus, (select status from public.approval_requests where target_id = o.id) req,
                     (select count(*)::int from public.voucher_usages u where u.order_id = o.id and u.reversed_at is not null) reversed
                     from public.orders o join public.vouchers v on v.id = o.voucher_id where o.id = $1`, [usedOrder])
  r[0].status === 'cancelled' && r[0].vstatus === 'available' && r[0].req === 'approved' && r[0].reversed === 1
    ? ok('order dibatalkan, voucher tersedia lagi, histori pemakaian & persetujuan tetap tercatat') : bad('cancel_order_now', JSON.stringify(r[0]))
  await expectFail('order yang sudah dibatalkan tidak bisa dibatalkan lagi', () => q(`select public.cancel_order_now($1, 'ulang')`, [usedOrder]), 'terkonfirmasi')
  await expectOk('owner mengembalikan FR D25 ke diisi manual', () => q(`select public.set_voucher_type_auto($1, null)`, [fr]))
})

console.log('\nHapus akun')
const accId = async (code) => (await q(`select id from public.accounts where account_code = $1`, [code]))[0]?.id
await as('owner', () => q(`select public.panel_add_account('KK','880001',null,null,'{}',gen_random_uuid()), public.panel_add_account('KK','880002',null,null,'{}',gen_random_uuid())`))
await db.exec('reset role')
const [safe1, safe2, withTrx] = [await accId('880001'), await accId('880002'), await accId('KK-0192')]
await expectFail('staf tidak bisa menghapus akun', () => as('rani', () => q(`select public.delete_accounts(array[$1]::uuid[])`, [safe1])), 'khusus owner')
await as('owner', async () => {
  const r = (await q(`select public.delete_accounts(array[$1]::uuid[]) r`, [withTrx]))[0].r
  r.deleted === 0 && r.results[0].reason.includes('transaksi') ? ok('akun dengan transaksi ditolak: ' + r.results[0].reason) : bad('hapus akun bertransaksi', JSON.stringify(r))
  const one = (await q(`select public.delete_accounts(array[$1]::uuid[]) r`, [safe1]))[0].r
  one.deleted === 1 && one.results[0].vouchers === 3 ? ok('akun aman dihapus beserta 3 vouchernya') : bad('hapus satu akun', JSON.stringify(one))
  const bulk = (await q(`select public.delete_accounts(array[$1, $2, gen_random_uuid()]::uuid[]) r`, [safe2, withTrx]))[0].r
  bulk.deleted === 1 && bulk.skipped === 2 && bulk.results.filter((x) => !x.ok).every((x) => x.reason)
    ? ok('bulk: 1 dihapus, 2 dilewati dengan alasan') : bad('bulk delete', JSON.stringify(bulk))
  const a = await q(`select action, after from public.audit_log where action in ('account.delete','account.bulk_delete') order by id`)
  a.length === 3 && a[2].action === 'account.bulk_delete' && a[2].after.deleted_count === 1 && a[2].after.skipped_count === 2
    ? ok('satu entri audit per operasi (ringkasan jumlah dihapus & dilewati)') : bad('audit hapus', JSON.stringify(a.map((x) => x.action)))
})
await db.exec('reset role')
const left = await q(`select (select count(*)::int from public.accounts where account_code in ('880001','880002')) acc,
  (select count(*)::int from public.vouchers where code like 'V-KK88000%') v, (select count(*)::int from public.orders where account_id = $1) trx`, [withTrx])
left[0].acc === 0 && left[0].v === 0 && left[0].trx > 0 ? ok('akun & voucher terhapus; order akun bertransaksi tetap utuh') : bad('sisa data', JSON.stringify(left[0]))
await expectFail('riwayat stok selain milik akun yang dihapus tetap append-only', () =>
  q(`delete from public.stock_ledger where id = (select id from public.stock_ledger where reason = 'restock' limit 1)`), 'append-only')

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

console.log('\nStatus kerja diatur owner')
{
  const sh = await as('owner', async () => {
    const code = (await q(`select public.add_extra_shift($1, now() - interval '5 hours', now() + interval '1 hour') c`, [ids.dimas]))[0].c
    return (await q(`select id from public.shifts where code = $1`, [code]))[0].id
  })
  const set = (status, minsAgo, reason = 'uji owner') =>
    q(`select public.owner_set_work_status($1, $2, now() - make_interval(mins => $3), $4)`, [sh, status, minsAgo, reason])
  await expectFail('staf tidak bisa mengubah status admin', () => as('dimas', () =>
    q(`select public.owner_set_work_status($1, 'masuk', null, 'uji')`, [sh])), 'khusus owner')
  await expectFail('alasan wajib diisi', () => as('owner', () => set('masuk', 240, '')), 'Alasan')
  await expectFail('belum masuk tidak bisa langsung Istirahat', () => as('owner', () => set('istirahat', 240)), 'belum masuk')
  await as('owner', async () => {
    await expectOk('owner: Masuk (waktu mundur 4 jam, admin lupa absen)', () => set('masuk', 240))
    await expectOk('owner: Istirahat 1 jam kemudian', () => set('istirahat', 180))
    await expectOk('owner: Istirahat → Off/Izin langsung', () => set('off', 120))
  })
  await expectFail('admin tidak bisa mengakhiri Off sendiri', () => as('dimas', () =>
    q(`select public.attendance_action($1, 'clock_out')`, [sh])), 'diatur owner')
  await as('owner', async () => {
    await expectFail('waktu sebelum peristiwa terakhir ditolak', () => set('masuk', 150), 'setelah peristiwa terakhir')
    await expectFail('waktu di masa depan ditolak', () => set('masuk', -30), 'masa depan')
    await expectOk('owner: kembali Masuk', () => set('masuk', 60))
    const m = (await q(`select * from public.shift_minutes($1)`, [sh]))[0]
    m.net_minutes === 120 && m.break_minutes === 60 ? ok('berjalan: 4 jam kotor − 1 jam istirahat − 1 jam Off = 2 jam kerja') : bad('menit kerja', JSON.stringify(m))
  })
  await as('dimas', async () => {
    await expectOk('admin tetap bisa Istirahat sendiri setelah owner mengubah status', () => q(`select public.attendance_action($1, 'break_start')`, [sh]))
    await expectOk('admin selesai istirahat sendiri', () => q(`select public.attendance_action($1, 'break_end')`, [sh]))
  })
  await as('owner', async () => {
    await expectOk('owner: Selesai', () => set('selesai', 0))
    const e = (await q(`select s.status, e.net_minutes, e.status es from public.shifts s join public.shift_earnings e on e.shift_id = s.id where s.id = $1`, [sh]))[0]
    e?.status === 'completed' && e.net_minutes >= 119 && e.net_minutes <= 120 && e.es === 'pending'
      ? ok('shift selesai; uang saku dihitung dari menit kerja bersih (' + e.net_minutes + ' menit), menunggu persetujuan') : bad('earning', JSON.stringify(e))
    const a = await q(`select before->>'status' b, after->>'status' s from public.audit_log where action = 'attendance.owner_status' and entity_id = $1 order by id`, [sh])
    a.map((x) => `${x.b}→${x.s}`).join(',') === 'belum→masuk,masuk→istirahat,istirahat→off,off→masuk,masuk→selesai'
      ? ok('audit mencatat status sebelum & sesudah tiap perubahan') : bad('audit status', JSON.stringify(a))
    const ev = await q(`select count(*)::int n, count(*) filter (where actor_id = $2)::int by_owner from public.attendance_events where shift_id = $1`, [sh, ids.owner])
    ev[0].n === 8 && ev[0].by_owner === 6 ? ok('riwayat event lengkap; pelaku owner tercatat (6 dari 8 event, 2 oleh admin)') : bad('event', JSON.stringify(ev[0]))
    await expectFail('shift yang sudah selesai tidak diubah lewat status', () => set('masuk', 0), 'sudah ditutup')
  })
}

console.log('\nKetidakhadiran (Tidak Masuk, Izin, Sakit)')
{
  const set = (sh, kind, note = null, att = null, reason = null) => q(`select public.set_shift_absence($1, $2, $3, $4, $5)`, [sh, kind, note, att, reason])
  const newShift = (admin, from, to) => as('owner', async () => {
    const code = (await q(`select public.add_extra_shift($1, now() + $2::interval, now() + $3::interval) c`, [admin, from, to]))[0].c
    return (await q(`select id from public.shifts where code = $1`, [code]))[0].id
  })
  const sh = await newShift(ids.dimas, '-30 minutes', '5 hours')
  await expectFail('staf tidak bisa menetapkan ketidakhadiran', () => as('rani', () => set(sh, 'izin')), 'khusus owner')
  await expectFail('status di luar 3 pilihan ditolak', () => as('owner', () => set(sh, 'cuti')), 'Pilih status')
  await expectFail('menghapus status yang belum ada ditolak', () => as('owner', () => set(sh, null, null, null, 'uji')), 'tidak punya status')
  await expectOk('owner menetapkan Izin dengan catatan', () => as('owner', () => set(sh, 'izin', 'Acara keluarga')))
  const row = (await q(`select status::text st, absence_kind k from public.shifts where id = $1`, [sh]))[0]
  row.st === 'absent' && row.k === 'izin' ? ok('shift tetap ada dengan status tidak hadir (Izin)') : bad('status absen', JSON.stringify(row))
  await expectFail('admin tidak bisa absen masuk di shift itu', () => as('dimas', () => q(`select public.attendance_action($1, 'clock_in')`, [sh])), 'tercatat tidak hadir')
  await expectFail('owner tidak bisa mengubah status kerja di shift itu', () => as('owner', () =>
    q(`select public.owner_set_work_status($1, 'masuk', null, 'uji')`, [sh])), 'tercatat tidak hadir')
  await expectFail('benefit tidak bisa diajukan', () => as('dimas', () => q(`select public.submit_benefit_claim($1, 'regular', 'x/y/z.jpg')`, [sh])), 'absen masuk')
  const m = (await q(`select net_minutes n, (select count(*)::int from public.shift_earnings e where e.shift_id = $1) earn from public.shift_minutes($1)`, [sh]))[0]
  m.n === 0 && m.earn === 0 ? ok('tidak ada jam kerja dan tidak ada uang saku') : bad('jam/uang saku', JSON.stringify(m))
  await expectFail('koreksi tanpa alasan ditolak', () => as('owner', () => set(sh, 'sakit')), 'alasan')
  await expectFail('koreksi tanpa perubahan ditolak', () => as('owner', () => set(sh, 'izin', 'Acara keluarga', null, 'uji ulang')), 'Tidak ada perubahan')
  await expectOk('owner mengoreksi Izin menjadi Sakit dengan alasan', () => as('owner', () => set(sh, 'sakit', 'Demam', null, 'salah pilih')))
  await expectOk('owner menghapus status', () => as('owner', () => set(sh, null, null, null, 'ternyata masuk')))
  const back = (await q(`select status::text st, absence_kind k from public.shifts where id = $1`, [sh]))[0]
  back.st === 'scheduled' && back.k === null ? ok('status kembali seperti semula') : bad('hapus status', JSON.stringify(back))
  const log = await q(`select previous_kind p, kind k, actor_id a from public.shift_absence_log where shift_id = $1 order by id`, [sh])
  log.map((x) => `${x.p}>${x.k}`).join(',') === 'null>izin,izin>sakit,sakit>null' && log.every((x) => x.a === ids.owner)
    ? ok('riwayat lengkap dengan pelaku owner: ' + log.length + ' perubahan') : bad('riwayat', JSON.stringify(log))
  const au = await q(`select after::text t from public.audit_log where action = 'attendance.absence' and entity_id = $1`, [sh])
  au.length === 3 && !au.some((x) => x.t.includes('Demam')) ? ok('audit mencatat 3 perubahan tanpa isi catatan') : bad('audit', JSON.stringify(au))
  await expectFail('riwayat tidak bisa diubah', () => q(`update public.shift_absence_log set note = 'x' where shift_id = $1`, [sh]))
  await expectOk('admin bisa absen lagi setelah status dihapus', () => as('dimas', () => q(`select public.attendance_action($1, 'clock_in')`, [sh])))
  await expectFail('shift yang sudah dimulai ditolak (pakai Off/Izin)', () => as('owner', () => set(sh, 'izin')), 'sudah dimulai')

  // Shift lewat tanpa absen: bisa ditandai, tidak ikut "tidak lengkap", dan kembali ke status asalnya bila dihapus.
  const past = await newShift(ids.dimas, '-30 hours', '-25 hours')
  await as('owner', () => q(`select public.flag_incomplete_shifts()`))
  await expectOk('shift lewat tanpa absen bisa ditandai Tidak Masuk', () => as('owner', () => set(past, 'tidak_masuk')))
  await as('owner', () => q(`select public.flag_incomplete_shifts()`))
  ;(await q(`select status::text s from public.shifts where id = $1`, [past]))[0].s === 'absent' ? ok('tombol "tanpa absen pulang" tidak menimpa status') : bad('flag menimpa')
  await as('owner', () => set(past, null, null, null, 'salah tanggal'))
  ;(await q(`select status::text s from public.shifts where id = $1`, [past]))[0].s === 'incomplete' ? ok('dihapus: kembali ke Tidak lengkap') : bad('status asal')

  // Rekap: dihitung terjadwal, tidak selesai, nilai uang tidak berubah.
  const mon = (await q(`select (date_trunc('week', current_date + 21))::date::text d`))[0].d
  await q(`insert into public.shifts (code, admin_id, kind, shift_date, planned_start, planned_end, created_by) values ('REG-ABSEN-UJI', $1, 'regular', $2::date, ($2::date + time '02:00') at time zone 'UTC', ($2::date + time '10:00') at time zone 'UTC', $3)`, [ids.dimas, mon, ids.owner])
  const reg = (await q(`select id from public.shifts where code = 'REG-ABSEN-UJI'`))[0].id
  const pay = await as('owner', async () => {
    await set(reg, 'sakit')
    await q(`select public.build_weekly_payroll($1, $2::date)`, [ids.dimas, mon])
    return (await q(`select regular_scheduled s, regular_completed c, base_total b, net_minutes n from public.weekly_payrolls where admin_id = $1 and period_start = $2::date`, [ids.dimas, mon]))[0]
  })
  pay.s === 1 && pay.c === 0 && Number(pay.b) === 0 && pay.n === 0 ? ok('rekap: 0 / 1 shift, Rp0, 0 jam') : bad('rekap', JSON.stringify(pay))

  // Rekap terkunci.
  const lock = await as('owner', async () => {
    const w = (await q(`select period_start::text d from public.weekly_payrolls where admin_id = $1 and status = 'paid' limit 1`, [ids.rani]))[0]
    return w?.d
  })
  if (lock) {
    await q(`insert into public.shifts (code, admin_id, kind, shift_date, planned_start, planned_end, created_by) values ('REG-ABSEN-KUNCI', $1, 'regular', $2::date + 6, ($2::date + 6 + time '02:00') at time zone 'UTC', ($2::date + 6 + time '10:00') at time zone 'UTC', $3)`, [ids.rani, lock, ids.owner])
    const locked = (await q(`select id from public.shifts where code = 'REG-ABSEN-KUNCI'`))[0].id
    await expectFail('rekap yang sudah dibayar tidak bisa diubah lewat ketidakhadiran', () => as('owner', () => set(locked, 'izin')), 'terkunci')
  } else bad('tidak ada rekap terkunci untuk diuji')

  // Hak baca: catatan & lampiran khusus owner.
  await as('dimas', async () => {
    const l = await q(`select count(*)::int n from public.shift_absence_log`)
    const st = await q(`select absence_kind k from public.shifts where id = $1`, [reg])
    l[0].n === 0 && st[0]?.k === 'sakit' ? ok('admin melihat statusnya, tetapi tidak melihat catatan & lampiran') : bad('hak baca', JSON.stringify([l, st]))
  })
  await expectFail('staf tidak bisa mengunggah bukti', () => as('rani', () => q(`insert into storage.objects (bucket_id, name, owner) values ('absence-proofs', $1, auth.uid())`, [`${reg}/x.pdf`])))
  await expectFail('lampiran yang tidak ada ditolak', () => as('owner', () => set(reg, 'sakit', 'Surat dokter', `${reg}/x.pdf`, 'tambah bukti')), 'Lampiran')
  await as('owner', async () => {
    await q(`insert into storage.objects (bucket_id, name, owner) values ('absence-proofs', $1, auth.uid())`, [`${reg}/x.pdf`])
    await expectOk('owner melampirkan bukti', () => set(reg, 'sakit', 'Surat dokter', `${reg}/x.pdf`, 'tambah bukti'))
    await expectOk('koreksi tanpa file baru', () => set(reg, 'izin', 'Surat dokter', null, 'ganti jenis'))
    const a = await q(`select attachment_path p from public.shift_absence_log where shift_id = $1 order by id desc limit 1`, [reg])
    a[0].p === `${reg}/x.pdf` ? ok('lampiran lama tetap berlaku setelah koreksi') : bad('lampiran', JSON.stringify(a))
  })
}

console.log('\nTinjauan order di Persetujuan')
{
  await db.exec('reset role')
  const pick = async () => (await q(`select v.id from public.vouchers v
    join public.voucher_types t on t.id = v.voucher_type_id
    join public.accounts a on a.id = v.account_id
    join lateral (select * from public.current_voucher_version(t.id)) ver on true
    where v.status = 'available' and a.inventory = 'regular' and v.allocated_cost is not null and coalesce(ver.min_purchase, 0) <= 100000
      and (ver.fixed_discount is not null or (ver.discount_pct is not null and ver.max_discount is not null))
    order by v.code limit 1`))[0].id
  // Harga merchant sengaja dibuat berbeda dari hitungan voucher, supaya order ditandai.
  const record = (voucher, override, confirm = true) => q(
    `select public.record_order($1, 'Uji Tinjau', '081234567890', null, 100000, 90000, 0, null, $2, $3, gen_random_uuid()) c`, [voucher, override, confirm])
  const make = async (user, override, confirm) => {
    const v = await pick()
    const code = await as(user, async () => (await record(v, override, confirm))[0].c)
    await db.exec('reset role')
    return (await q(`select id from public.orders where code = $1`, [code]))[0].id
  }
  const reviews = async (id) => { await db.exec('reset role'); return q(`select id, status, requested_by, reason, decided_by, decision_note from public.approval_requests where kind = 'order_review' and target_id = $1`, [id]) }
  const order = async (id) => { await db.exec('reset role'); return (await q(`select o.status, o.needs_review, o.review_status, o.review_reasons, o.net_profit, o.sell_price, v.status vstatus from public.orders o join public.vouchers v on v.id = o.voucher_id where o.id = $1`, [id]))[0] }
  const decide = (req, approve, note) => q(`select public.decide_approval($1, $2, $3)`, [req, approve, note])

  const clean = await make('rani', null)
  ;(await reviews(clean)).length === 0 ? ok('order tanpa selisih tidak masuk antrean') : bad('order bersih masuk antrean')

  const a = await make('rani', 50000)
  const [ra] = await reviews(a)
  ra?.status === 'pending' && ra.requested_by === ids.rani && ra.reason.includes('Harga merchant berbeda') ? ok('order bertanda langsung masuk antrean, tercatat atas nama admin') : bad('antrean', JSON.stringify(ra))

  const draft = await make('rani', 50000, false)
  ;(await reviews(draft)).length === 0 ? ok('draft bertanda belum masuk antrean') : bad('draft masuk antrean')
  await as('rani', () => q(`select public.confirm_draft($1)`, [draft]))
  ;(await reviews(draft))[0]?.status === 'pending' ? ok('draft masuk antrean saat dikonfirmasi') : bad('confirm_draft tidak membuat pengajuan')

  const dropped = await make('rani', 50000, false)
  await as('rani', () => q(`select public.cancel_draft($1)`, [dropped]))
  ;(await reviews(dropped)).length === 0 ? ok('draft yang dibatalkan tidak masuk antrean') : bad('draft batal masuk antrean')

  await expectFail('staf tidak bisa memutuskan tinjauan', () => as('rani', () => decide(ra.id, true, null)), 'owner')
  await expectFail('menolak tanpa alasan ditolak', () => as('owner', () => decide(ra.id, false, '  ')), 'alasan')
  const before = await order(a)
  await as('owner', () => decide(ra.id, false, 'Harga merchant tidak wajar'))
  const after = await order(a); const [rb] = await reviews(a)
  after.status === 'confirmed' && after.vstatus === 'used' && !after.needs_review && after.review_status === 'rejected'
    && after.net_profit === before.net_profit && after.sell_price === before.sell_price && after.review_reasons.length === before.review_reasons.length
    ? ok('ditolak: order, voucher, dan angka tetap; label selesai; alasan awal tersimpan') : bad('tolak', JSON.stringify(after))
  rb.status === 'rejected' && rb.decided_by === ids.owner && rb.decision_note === 'Harga merchant tidak wajar' ? ok('keputusan & identitas owner tercatat') : bad('catatan keputusan', JSON.stringify(rb))
  await expectFail('keputusan tidak bisa diulang', () => as('owner', () => decide(ra.id, true, null)), 'sudah diputuskan')
  await as('rani', async () => { (await q(`select decision_note n from public.approval_requests where target_id = $1`, [a]))[0]?.n ? ok('admin pencatat bisa membaca alasan penolakan') : bad('alasan tidak terbaca admin') })
  await as('dimas', async () => { (await q(`select 1 from public.approval_requests where target_id = $1`, [a])).length === 0 ? ok('admin lain tidak bisa membaca keputusan') : bad('keputusan terbaca admin lain') })
  await db.exec('reset role')
  ;(await q(`select count(*)::int n from public.audit_log where entity_id = $1 and action = 'approval.reject'`, [ra.id]))[0].n === 1 ? ok('penolakan masuk audit log') : bad('audit penolakan')

  const b = await make('rani', 50000)
  const [rc] = await reviews(b)
  await as('owner', () => decide(rc.id, true, null))
  const ob = await order(b)
  ob.status === 'confirmed' && !ob.needs_review && ob.review_status === 'approved' ? ok('disetujui: order tetap, label selesai') : bad('setujui', JSON.stringify(ob))

  const c = await make('rani', 50000)
  const [rd] = await reviews(c)
  await as('owner', () => q(`select public.cancel_order_now($1, 'salah input')`, [c]))
  const [rd2] = await reviews(c)
  rd2.status === 'closed' && rd2.decision_note.includes('Ditutup otomatis') ? ok('order dibatalkan saat menunggu: pengajuan tertutup, tidak tersisa pending') : bad('tutup otomatis', JSON.stringify(rd2))
  await expectFail('pengajuan yang tertutup tidak bisa diputuskan', () => as('owner', () => decide(rd.id, true, null)), 'sudah diputuskan')

  const rej = await make('rani', 50000)
  const [re] = await reviews(rej)
  await as('owner', () => decide(re.id, false, 'Perlu dibatalkan'))
  const req = await as('rani', async () => (await q(`select public.request_order_cancel($1, 'ikut keputusan owner') id`, [rej]))[0].id)
  await as('owner', () => decide(req, true, null))
  const orej = await order(rej)
  orej.status === 'cancelled' && orej.vstatus === 'available' ? ok('order yang ditolak tetap bisa dibatalkan lewat jalur resmi') : bad('batal setelah ditolak', JSON.stringify(orej))

  // Data lama: pernyataan pengisian yang sama persis dengan migrasi, pada order yang bertanda sebelum trigger ada.
  await db.exec('reset role')
  const sql = readFileSync(join(root, 'supabase/migrations/20261031000022_order_review.sql'), 'utf8')
  const backfill = sql.slice(sql.indexOf('insert into public.approval_requests (kind, target_id, reason, requested_by, requested_at)'), sql.indexOf('-- 3. Keputusan owner'))
  await db.exec('alter table public.orders disable trigger orders_review_sync')
  const old = await make('rani', 50000)
  const oldCancelled = await make('rani', 50000)
  await db.exec(`update public.orders set status = 'cancelled', cancelled_at = now() where id = '${oldCancelled}'`)
  await db.exec('alter table public.orders enable trigger orders_review_sync')
  const money = (await q(`select coalesce(sum(net_profit), 0)::text s, count(*)::int n from public.orders`))[0]
  await db.exec(backfill); await db.exec(backfill)
  const moneyAfter = (await q(`select coalesce(sum(net_profit), 0)::text s, count(*)::int n from public.orders`))[0]
  const oldReq = await reviews(old)
  oldReq.length === 1 && oldReq[0].status === 'pending' && oldReq[0].requested_by === ids.rani ? ok('order lama bertanda masuk antrean, sekali saja walau diulang') : bad('pengisian data lama', JSON.stringify(oldReq))
  ;(await reviews(oldCancelled)).length === 0 ? ok('order lama yang dibatalkan tidak masuk antrean') : bad('order batal masuk antrean')
  money.s === moneyAfter.s && money.n === moneyAfter.n ? ok('pengisian data lama tidak mengubah angka order') : bad('angka berubah', JSON.stringify([money, moneyAfter]))
  const stale = await q(`select count(*)::int n from public.orders o where o.needs_review and o.status = 'confirmed'
    and not exists (select 1 from public.approval_requests r where r.kind = 'order_review' and r.target_id = o.id and r.status = 'pending')`)
  stale[0].n === 0 ? ok('setiap order bertanda punya tepat satu pengajuan menunggu') : bad('order bertanda tanpa pengajuan', JSON.stringify(stale))
}

console.log(failed ? `\n${failed} pemeriksaan gagal` : '\nSemua pemeriksaan lulus')
process.exit(failed ? 1 : 0)
