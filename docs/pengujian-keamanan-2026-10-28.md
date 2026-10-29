# Laporan Pengujian Menyeluruh & Tinjauan Keamanan

Tanggal: 28 Oktober 2026 · Lingkungan: pengembangan lokal (Supabase lokal, data dummy) · Tidak ada sistem produksi yang disentuh.

## Ringkasan

| Area | Hasil |
|---|---|
| Uji keamanan API (`npm run test:security`) | 80 pemeriksaan lulus, setelah 1 temuan tinggi diperbaiki |
| Pemeriksaan database offline (`npm run db:check`) | Semua lulus (termasuk 3 pemeriksaan baru gerbang password) |
| Alur di browser (staf & owner) | Semua alur berjalan; angka dicocokkan dengan hitungan manual |
| Build produksi, TypeScript, ESLint | Lulus |
| Dependensi (`npm audit`) | Kritis & tinggi pada runtime diperbaiki; 1 sisa (lihat Risiko diterima) |

## Temuan & perbaikan

| # | Tingkat | Temuan | Perbaikan |
|---|---|---|---|
| 1 | **Kritis** | Next.js 15.5.4 / React 19.1.0 rentan RCE lewat protokol React Server Components, plus kebocoran kode Server Actions dan DoS. | Naik ke Next 15.5.28 & React 19.1.10 (patch, bukan versi mayor). supabase-js 2.118, @supabase/ssr 0.12, zod 4 ikut diperbarui. |
| 2 | **Tinggi** | CAPTCHA & pembatasan percobaan login bisa dilewati: endpoint login Supabase Auth bisa dipanggil langsung dengan anon key (yang memang publik) tanpa token CAPTCHA. Terbukti oleh uji. | CAPTCHA kini diverifikasi oleh Supabase Auth sendiri (`[auth.captcha]` Turnstile, kunci rahasia di `supabase/.env`). Route login meneruskan token; login langsung tanpa token ditolak (`no captcha_token found`). |
| 3 | Sedang | Akun yang direset owner (wajib ganti password) hanya dihadang di halaman aplikasi; lewat API masih bisa mencatat order/absen. Penanda bisa dihapus tanpa benar-benar mengganti password. | `require_active()` menolak akun wajib-ganti-password. Hash password sementara disimpan di tabel tertutup; `mark_password_changed()` hanya berhasil bila hash di Auth sudah berbeda. |
| 4 | Sedang | Cookie sesi bisa dibaca skrip halaman (bukan `httpOnly`). | Cookie sesi `httpOnly`, `SameSite=Lax`, `Secure` di produksi. Aplikasi tidak memakai klien Supabase di browser. |
| 5 | Rendah | Tidak ada header keamanan (halaman bisa dimuat di iframe situs lain). | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS di produksi; header `X-Powered-By` dimatikan. |
| 6 | Lingkungan | `supabase db reset/start` macet menunggu container realtime yang tidak sehat. | `db:start` hanya menjalankan layanan yang dipakai (DB, Auth, REST). |

## Yang diuji dan lulus

**Akses anonim** — 14 tabel/view dan fungsi ditolak (`permission denied`).

**Staf membaca yang bukan haknya** — tabel akun asli, device VM, audit log, percobaan login, pembelian, biaya, order/shift/uang saku/rekap admin lain: 0 baris atau ditolak. Nomor akun VM & WhatsApp customer admin lain tersamar.

**Staf menulis langsung** — 17 percobaan (ubah peran sendiri jadi owner, beri izin restock sendiri, ubah status voucher, hapus voucher/histori stok/audit log, ubah order & rekap gaji, sisip klaim/absen langsung, ubah aturan voucher/bonus/harga kredit/jadwal): semua ditolak.

**Fungsi khusus owner/internal** — 18 fungsi (VM, persetujuan, earning, payroll, jadwal, staf, fungsi internal `_create_account`, `write_audit`, dll.) ditolak untuk staf. Staf tanpa izin tidak bisa restock Panel; staf berizin tidak bisa menambah stok akun VM; staf tidak bisa absen/klaim di shift orang lain.

**Bersamaan & ganda** — 3 admin memakai voucher yang sama bersamaan → 1 berhasil. Restock dikirim 2× dengan kunci sama → 1 akun. Absen masuk/pulang dan klaim benefit bersamaan → masing-masing 1. Pencairan kedua ditolak.

**Akun nonaktif & token palsu** — token akun nonaktif tidak bisa membaca/menulis; JWT palsu atas nama owner ditolak.

**Alur browser** (login lewat form dengan CAPTCHA asli):
- Staf: absen masuk → klaim benefit → istirahat → pulang; order terkonfirmasi (laba Rp3.667) dan draft (laba Rp6.667) → konfirmasi draft → ajukan batal; restock Panel Starbucks (4 × Rp1.500); ajukan koreksi stok.
- Owner: setujui batal order (voucher kembali tersedia) & koreksi stok (voucher rusak); setujui uang saku → rekap → cair (`PAY-2026W44-rani`); Keuangan harian cocok (omzet Rp161.000 tanpa order batal, laba bersih Rp22.500 setelah biaya Rp4.000 & voucher rusak Rp1.500); tambah akun VM; versi aturan Tomoro; buat staf baru → wajib ganti password → masuk.

## Risiko diterima / catatan untuk staging

- **postcss di dalam Next.js** (tinggi menurut `npm audit`): hanya memproses CSS milik proyek saat build, tanpa input pengguna. Hilang bila pindah ke Next 16 (versi mayor).
- **Batas percobaan per IP** memakai header `x-forwarded-for`. Di staging/produksi pastikan header ini diisi oleh platform/proxy tepercaya, bukan diteruskan dari klien.
- **Batas 5 gagal per username** bisa dipakai orang lain untuk mengunci login seseorang selama 15 menit. Ini kompromi yang disengaja melawan tebak password.
- Kunci uji Turnstile (selalu lolos) hanya untuk lokal. Staging wajib memakai site key & secret asli, dan secret Supabase Auth (`SUPABASE_AUTH_CAPTCHA_SECRET`) harus diisi.
- Pengujian HP memakai emulasi browser; perlu dicoba di perangkat sungguhan.

## Cara mengulang

```bash
npm run db:reset
npm run test:security
npm run db:check
```
