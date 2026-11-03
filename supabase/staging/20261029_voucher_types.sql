-- Konfigurasi awal jenis & ketentuan voucher untuk Supabase STAGING (bukan migration, bukan seed lokal).
-- Dijalankan sekali oleh admin (SQL editor / MCP) setelah brand ada. Aman diulang: jenis yang sudah ada
-- dan jenis yang sudah punya versi ketentuan tidak disentuh, sehingga perubahan owner lewat aplikasi tetap.
--
-- Prinsip: hanya nilai yang dikonfirmasi owner. Ketentuan yang belum lengkap TIDAK diberi versi, sehingga
-- aplikasi menampilkan "belum dikonfigurasi" dan order memakai potongan manual + ditandai untuk ditinjau.
-- min_purchase NULL = tanpa minimum (sesuai form Konfigurasi Voucher). Biaya brand, bonus, dan VM tidak diubah.

begin;

do $$
begin
  if not exists (select 1 from public.profiles
                 where id = '99c77d45-4b4c-486c-b990-fee7f1857893' and role = 'owner' and is_active) then
    raise exception 'Profil owner vierr tidak ditemukan; dibatalkan';
  end if;
  if (select count(*) from public.brands where id in ('KK', 'TM', 'JJ', 'FR', 'SB')) <> 5 then
    raise exception 'Brand KK/TM/JJ/FR/SB belum lengkap; dibatalkan';
  end if;
end $$;

-- 1. Jenis voucher -----------------------------------------------------------------------------------
-- grp main + auto 1 = dibuat otomatis 1 per akun baru (A, B, C KopKen).
-- grp extra + auto NULL = jumlah diisi saat restock; bisa direstock terpisah lewat "Baperan saja" (BP).
-- Brand lain: auto NULL (jumlah per akun belum dikonfirmasi, diisi saat restock).
with t (brand_id, code, name, grp, auto_per_account, sort_order) as (values
  ('KK', 'A',    'Diskon 50% tanpa minimum', 'main'::public.voucher_group,  1::smallint,    1::smallint),
  ('KK', 'B',    'Diskon 50% min. Rp50.000', 'main'::public.voucher_group,  1::smallint,    2::smallint),
  ('KK', 'C',    'Diskon 50% min. Rp70.000', 'main'::public.voucher_group,  1::smallint,    3::smallint),
  ('KK', 'BP',   'Baperan',                  'extra'::public.voucher_group, null::smallint, 4::smallint),
  ('TM', 'D50',  'Diskon 50%',               'main'::public.voucher_group,  null::smallint, 1::smallint),
  ('TM', 'B1G1', 'Beli 1 Gratis 1',          'main'::public.voucher_group,  null::smallint, 2::smallint),
  ('JJ', 'V',    'Voucher Janji Jiwa',       'main'::public.voucher_group,  null::smallint, 1::smallint),
  ('FR', 'D25',  'Diskon 25%',               'main'::public.voucher_group,  null::smallint, 1::smallint),
  ('SB', 'SB',   'Voucher Starbucks',        'main'::public.voucher_group,  null::smallint, 1::smallint)
), ins as (
  insert into public.voucher_types (brand_id, code, name, grp, auto_per_account, sort_order)
  select brand_id, code, name, grp, auto_per_account, sort_order from t
  on conflict (brand_id, code) do nothing
  returning brand_id, code
)
insert into public.audit_log (actor_id, action, entity, entity_id, before, after)
select '99c77d45-4b4c-486c-b990-fee7f1857893', 'masterdata.voucher_types.initial', 'voucher_types', null, null,
       jsonb_build_object('created', jsonb_agg(brand_id || '-' || code order by brand_id, code),
                          'note', 'Konfigurasi awal staging atas instruksi owner')
from ins having count(*) > 0;

-- 2. Ketentuan (versi pertama) hanya untuk jenis yang ketentuannya lengkap dikonfirmasi -----------------
-- Tidak diberi versi (tetap "belum dikonfigurasi", potongan manual + ditinjau):
--   TM D50  (batas potongan & minimum belum dikonfirmasi; versi 50% tanpa batas akan memberi diskon otomatis)
--   TM B1G1 (bukan potongan Rupiah/persen; minimum belum dikonfirmasi)
--   JJ V    (ketentuan belum dikonfirmasi)
--   SB SB   (harga referensi Rp35.000 Grande ada di data brand, bukan ketentuan voucher)
with v (brand_id, code, discount_pct, fixed_discount, min_purchase, max_discount) as (values
  ('KK', 'A',   50.0::numeric, null::integer, null::integer, 35000::integer),
  ('KK', 'B',   50.0,          null,          50000,         30000),
  ('KK', 'C',   50.0,          null,          70000,         30000),
  ('KK', 'BP',  null,          8000,          null,          null),
  ('FR', 'D25', 25.0,          null,          null,          50000)
), ins as (
  insert into public.voucher_type_versions (voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount,
                                            effective_from, created_by)
  select vt.id, v.discount_pct, v.fixed_discount, v.min_purchase, v.max_discount,
         '2026-10-29 00:00:00+07', '99c77d45-4b4c-486c-b990-fee7f1857893'
  from v join public.voucher_types vt on vt.brand_id = v.brand_id and vt.code = v.code
  where not exists (select 1 from public.voucher_type_versions x where x.voucher_type_id = vt.id)
  returning voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount
)
insert into public.audit_log (actor_id, action, entity, entity_id, before, after)
select '99c77d45-4b4c-486c-b990-fee7f1857893', 'masterdata.voucher_versions.initial', 'voucher_type_versions', null, null,
       jsonb_build_object('versions', jsonb_agg(jsonb_build_object('type', vt.brand_id || '-' || vt.code,
                            'discount_pct', ins.discount_pct, 'fixed_discount', ins.fixed_discount,
                            'min_purchase', ins.min_purchase, 'max_discount', ins.max_discount) order by vt.brand_id, vt.code),
                          'effective_from', '2026-10-29 00:00 WIB')
from ins join public.voucher_types vt on vt.id = ins.voucher_type_id having count(*) > 0;

commit;
