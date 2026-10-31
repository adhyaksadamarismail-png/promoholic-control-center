-- Jenis & status baru untuk antrean Persetujuan. Dipisah dari migrasi berikutnya karena nilai enum baru
-- belum bisa dipakai dalam transaksi yang sama.
alter type public.approval_kind add value if not exists 'order_review';
-- 'closed' = pengajuan ditutup sistem tanpa keputusan owner (mis. ordernya dibatalkan lebih dulu).
alter type public.approval_status add value if not exists 'closed';
