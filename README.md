# Promo.Holic Control Center

Dashboard internal operasional Promo.Holic: akun & voucher (VM dan Panel Admin), transaksi order, stok & restock,
keuangan, absensi, uang saku, bonus shift tambahan, dan benefit KopKen.

Tahap ini: **pengembangan lokal** — skema database, aturan akses, fungsi server, data dummy, login dengan CAPTCHA,
modul Absensi & Benefit (staf + owner + persetujuan), dan modul Order & Akun (form transaksi, daftar & detail akun).
Belum terhubung ke database produksi dan belum di-deploy.

Halaman yang sudah aktif: `/attendance`, `/owner/attendance`, `/approvals`, `/orders/new`, `/accounts`, `/accounts/[id]`,
`/accounts/export`, `/panel`, `/stock`, `/stock/export`, `/account/password`. Menu lain (Riwayat Voucher, Keuangan,
Virtual Machine, Konfigurasi Voucher) belum dibangun.

## Teknologi

- Next.js 15 (App Router, TypeScript, Tailwind CSS 4)
- Supabase: Auth, PostgreSQL, Row Level Security, fungsi `SECURITY DEFINER`
- Cloudflare Turnstile untuk CAPTCHA (diverifikasi di server)

## Menjalankan secara lokal

Kebutuhan: Node.js 20+, dan **Docker Desktop** (atau OrbStack) untuk Supabase lokal.

```bash
npm install
npm run db:start          # menjalankan Supabase lokal, menampilkan URL, anon key, service role key
cp .env.example .env.local # lalu isi kunci dari output db:start
npm run db:reset          # menerapkan migrasi + seed data dummy
npm run dev               # http://localhost:3000
```

Akun uji lokal ada di `supabase/seed.sql` (username `owner`, `rani`, `dimas`, `sekar`, `bayu`).
Kunci Turnstile di `.env.example` adalah kunci uji resmi Cloudflare yang selalu lolos — ganti untuk staging/produksi.

Jika `db:start` gagal karena health check container tambahan (Studio, storage) kehabisan waktu, jalankan layanan inti saja:

```bash
npx supabase start -x studio,postgres-meta,edge-runtime,logflare,vector,imgproxy,storage-api
```

Jika perintah `docker` tidak dikenali padahal Docker Desktop sudah berjalan, buka Docker Desktop sekali agar CLI-nya terpasang,
atau tambahkan `/Applications/Docker.app/Contents/Resources/bin` ke PATH.

### Pemeriksaan tanpa Docker

```bash
npm run db:check
```

Menjalankan semua migrasi + seed di PGlite (Postgres di Node) dengan tiruan skema `auth`, lalu menguji aturan akses dan
alur utama: penolakan VM untuk staf, voucher utama tidak dibuat ulang, idempotensi restock, aturan minimum/maks potongan,
voucher tidak bisa dipakai dua kali, pembatalan resmi, urutan absen, klaim benefit sekali per shift, dan pencairan
sekali per periode. Ini tidak menggantikan pengujian dengan Supabase asli.

## Struktur

```
supabase/migrations/
  …0001_core.sql                 profil & peran, audit log, persetujuan, percobaan login
  …0002_inventory_orders.sql     brand, harga modal berversi, voucher berversi, device VM, akun, voucher, restock, order
  …0003_attendance.sql           jadwal, shift, absensi, aturan uang saku & bonus, earning, payroll, benefit
  …0004_rls.sql                  RLS + view tersamar untuk staf
  …0005_functions_inventory.sql  restock VM/Panel, tambah stok, order, draft, pembatalan, koreksi stok
  …0006_functions_attendance.sql shift, absen, earning, payroll, klaim benefit, persetujuan, akun staf
  …0007_schedule_password.sql    perubahan jadwal berversi, penanda ganti password
supabase/seed.sql                data dummy lokal
scripts/check-db.mjs             pemeriksa PGlite
src/app/login                    login + Turnstile
src/app/api/auth                 route login (rate limit + CAPTCHA) & logout
src/app/(app)                    halaman setelah login (attendance, owner/attendance, approvals, orders/new, accounts)
src/app/account/password         ganti password wajib setelah reset owner
src/lib                          format, pemanggil RPC, aturan tampilan absensi & voucher
```

## Prinsip keamanan

- Tidak ada pendaftaran publik; akun staf dibuat owner. Password di-hash Supabase Auth.
- Peran dibaca dari tabel `profiles` berdasarkan sesi, tidak pernah dari input.
- Semua penulisan data operasional lewat fungsi database yang mengecek peran; staf tidak punya hak INSERT/UPDATE/DELETE langsung.
- Waktu absen dan klaim selalu `now()` di server. Histori stok, absensi, dan audit log hanya bisa ditambah.
- `SUPABASE_SERVICE_ROLE_KEY` hanya dipakai di route server.

## Nilai yang masih contoh (bisa diubah owner)

Tarif bonus shift tambahan (seed: Rp4.500/jam bersih), batas istirahat wajar (120 menit), batas durasi wajar (14 jam),
dan batas uang saku (tidak dibatasi). Semua tersimpan sebagai aturan berversi, bukan angka di kode.
