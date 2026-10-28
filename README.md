# Promo.Holic Control Center

Dashboard internal operasional Promo.Holic: akun & voucher (VM dan Panel Admin), transaksi order, stok & restock,
keuangan, absensi, uang saku, bonus shift tambahan, dan benefit KopKen.

Tahap ini: **pengembangan lokal** — skema database, aturan akses, fungsi server, data dummy, login dengan CAPTCHA,
modul Absensi & Benefit (staf + owner + persetujuan), dan modul Order & Akun (form transaksi, daftar & detail akun).
Belum terhubung ke database produksi dan belum di-deploy.

Halaman yang sudah aktif: `/attendance`, `/owner/attendance`, `/approvals`, `/orders/new`, `/accounts`, `/accounts/[id]`,
`/accounts/export`, `/panel`, `/stock`, `/stock/export`, `/vm`, `/finance`, `/finance/export`, `/vouchers/history`,
`/vouchers/history/export`, `/settings/vouchers`, `/api/benefit-receipt/[claim]`, `/account/password`. Semua menu di desain sudah memiliki halaman.

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
cp supabase/.env.example supabase/.env   # kunci rahasia CAPTCHA untuk Supabase Auth (lokal: kunci uji)
npm run db:reset          # menerapkan migrasi + seed data dummy
npm run dev               # http://localhost:3000
```

Akun uji lokal ada di `supabase/seed.sql` (username `owner`, `rani`, `dimas`, `sekar`, `bayu`).
Kunci Turnstile di `.env.example` adalah kunci uji resmi Cloudflare yang selalu lolos — ganti untuk staging/produksi.

`db:start` hanya menjalankan layanan yang dipakai aplikasi (database, Auth, REST, Storage untuk bukti receipt). Studio, realtime, dan
layanan lain sengaja dilewati karena health check-nya sering membuat start/reset macet.

Jika perintah `docker` tidak dikenali padahal Docker Desktop sudah berjalan, buka Docker Desktop sekali agar CLI-nya terpasang,
atau tambahkan `/Applications/Docker.app/Contents/Resources/bin` ke PATH.

### Uji keamanan lewat API (butuh Supabase lokal)

```bash
npm run db:reset
npm run test:security
```

Menyerang API Supabase langsung memakai anon key (yang memang publik) sebagai anonim, staf, staf tanpa izin, akun nonaktif,
dan token palsu: login tanpa CAPTCHA, baca/tulis tabel yang bukan haknya, panggil fungsi owner/internal, pemakaian voucher
bersamaan, restock & klaim ganda, serta gerbang wajib ganti password. Mengubah data uji; jalankan `db:reset` sesudahnya.

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
- CAPTCHA diverifikasi oleh Supabase Auth sendiri (`[auth.captcha]`), jadi login langsung ke API tanpa token juga ditolak.
- Cookie sesi `httpOnly` + `SameSite=Lax` (`Secure` di produksi); header keamanan (anti-iframe, nosniff, HSTS di produksi).
- Akun yang direset owner tidak bisa beraksi lewat API sampai password benar-benar diganti (dicek dari hash, bukan pengakuan klien).
- Bukti receipt benefit disimpan di bucket Storage privat `benefit-receipts` (tanpa URL publik, maks 5 MB, JPG/PNG/WebP
  dicek dari isi file). Admin hanya bisa mengunggah/membaca foldernya sendiri; owner membaca lewat route aplikasi, dan
  persetujuan klaim ditolak database bila owner belum membuka buktinya.
- Peran dibaca dari tabel `profiles` berdasarkan sesi, tidak pernah dari input.
- Semua penulisan data operasional lewat fungsi database yang mengecek peran; staf tidak punya hak INSERT/UPDATE/DELETE langsung.
- Waktu absen dan klaim selalu `now()` di server. Histori stok, absensi, dan audit log hanya bisa ditambah.
- `SUPABASE_SERVICE_ROLE_KEY` hanya dipakai di route server.

## Nilai yang masih contoh (bisa diubah owner)

Tarif bonus shift tambahan (seed: Rp4.500/jam bersih), batas istirahat wajar (120 menit), batas durasi wajar (14 jam),
dan batas uang saku (tidak dibatasi). Semua tersimpan sebagai aturan berversi, bukan angka di kode.
