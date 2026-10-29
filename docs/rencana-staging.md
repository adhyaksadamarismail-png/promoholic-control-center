# Rencana Staging — Promo.Holic Control Center

Staging = salinan online untuk uji coba dengan data & akun asli, **terpisah dari produksi**. Tidak ada yang
dihubungkan sebelum rencana ini disetujui owner.

## 1. Yang perlu disiapkan owner

| Kebutuhan | Keterangan | Biaya awal |
|---|---|---|
| Repository GitHub (privat) | Tempat kode; hosting membaca dari sini | Gratis |
| Akun Supabase + project **staging** | Database, login, storage receipt. Region Singapura (`ap-southeast-1`) | Free tier cukup untuk uji coba |
| Akun Vercel | Hosting aplikasi Next.js, terhubung ke GitHub | Hobby gratis (untuk pemakaian bisnis, pertimbangkan Pro) |
| Cloudflare Turnstile | Site key + secret key **asli** untuk domain staging | Gratis |
| (Opsional) subdomain | mis. `staging-cc.promoholic.id`; tanpa ini pakai alamat `*.vercel.app` | — |

## 2. Langkah teknis (dikerjakan setelah disetujui)

1. **Supabase staging**
   - Hubungkan project: `npx supabase link --project-ref <ref-staging>`.
   - Terapkan migrasi saja: `npx supabase db push` (**tanpa** `seed.sql` — data dummy tidak ikut).
   - Auth: matikan pendaftaran publik, aktifkan CAPTCHA Turnstile dengan secret asli, panjang password min. 10.
   - Storage: bucket `benefit-receipts` dibuat oleh migrasi (privat, 5 MB, JPG/PNG/WebP).
   - Jalankan Security Advisor Supabase; target: tidak ada peringatan RLS.
2. **Akun owner pertama** — dibuat sekali lewat dashboard Supabase / skrip server, lalu profil `owner`.
   Akun staf selanjutnya dibuat owner dari menu *Absensi & Staf → Akun staf* (password sementara, wajib diganti).
3. **Konfigurasi bisnis oleh owner** (nilai asli, bukan contoh): harga kredit, modal per brand, ketentuan
   voucher per brand (Janji Jiwa & Tomoro masih "belum dikonfigurasi"), aturan uang saku & bonus, jadwal reguler,
   virtual device.
4. **Vercel** — import repo, environment variables:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (hanya server),
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `STAFF_EMAIL_DOMAIN`. Hanya branch staging yang dideploy ke staging.
5. **Data awal** — akun & voucher asli dimasukkan lewat **Bulk Restock** (Panel / VM), dengan preview sebelum simpan.
6. **Uji penerimaan** — ulangi `npm run test:security` terhadap staging dengan akun uji khusus, lalu uji alur
   harian oleh owner & staf di HP.

## 3. Keamanan yang wajib dicek sebelum dipakai

- Header IP untuk batas percobaan login berasal dari Vercel (`x-forwarded-for` diisi platform).
- `SUPABASE_SERVICE_ROLE_KEY` tidak pernah memakai prefix `NEXT_PUBLIC_`.
- Kunci uji Turnstile (`1x0000…`) **tidak** dipakai di staging.
- Backup harian Supabase aktif sebelum data asli masuk.

## 4. Di luar cakupan staging

Produksi (domain utama, migrasi ke project produksi) direncanakan terpisah setelah staging disetujui owner.
