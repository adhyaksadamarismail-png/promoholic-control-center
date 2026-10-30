-- Inventaris Baperan terpisah dari akun reguler (non-destruktif):
-- 1) Satu nomor telepon = satu akun Baperan, otomatis berisi tepat 1 voucher Baperan. PIN opsional (khusus owner),
--    masa aktif wajib dan tersimpan sebagai data akun (accounts.active_until).
-- 2) Voucher Baperan tidak boleh lagi dibuat di akun reguler/VM atau sebagai "Baperan lepas"; akun Baperan hanya
--    berisi voucher Baperan. Data lama tidak diubah (di staging belum ada voucher Baperan).
-- 3) Voucher dari akun Baperan yang masa aktifnya lewat tidak bisa dipakai untuk transaksi baru. Tidak ada yang
--    dihapus otomatis: akun, voucher, dan riwayat tetap ada.

-- 1. Kolom ------------------------------------------------------------------
-- Jenis voucher Baperan = voucher tambahan berkode BP (kode yang sudah dipakai konfigurasi & parser Bulk Restock).
alter table public.voucher_types add column is_baperan boolean generated always as (grp = 'extra' and code = 'BP') stored;

alter table public.accounts
  add column inventory text not null default 'regular' check (inventory in ('regular', 'baperan')),
  add column pin text check (pin ~ '^[0-9]{4,8}$');
-- Nomor telepon kini juga dipakai akun Baperan (sumber Panel); akun Panel reguler tetap tanpa nomor & device.
alter table public.accounts drop constraint accounts_check1;
alter table public.accounts add constraint accounts_source_fields check (
  (source = 'vm' and inventory = 'regular' and vm_device_id is not null and account_number is not null)
  or (source = 'panel' and inventory = 'regular' and vm_device_id is null and account_number is null and pin is null)
  or (source = 'panel' and inventory = 'baperan' and vm_device_id is null and account_number is not null and active_until is not null)
);

create sequence public.baperan_seq;

-- Daftar akun untuk semua pengguna aktif. Nomor akun Baperan terlihat utuh oleh staf (dipakai saat menebus voucher);
-- nomor akun VM tetap disamarkan untuk staf. PIN hanya untuk owner. Kolom baru ditambahkan di akhir.
create or replace view public.account_list with (security_barrier = true) as
select a.id, a.brand_id, a.account_code, a.source,
       case when public.is_owner() then a.vm_device_id end as vm_device_id,
       case when public.is_owner() or a.inventory = 'baperan' then a.account_number else public.mask_tail(a.account_number) end as account_number,
       case when public.is_owner() then a.identity_note end as identity_note,
       a.entered_at, a.active_until, a.needs_review, a.review_note,
       a.inventory,
       case when public.is_owner() then a.pin end as pin
from public.accounts a
where public.is_active_user();

-- 2. Penjaga pemisahan inventaris -------------------------------------------
-- Berlaku untuk semua jalur pembuatan voucher (akun baru, tambah voucher, Bulk Restock, restock tambahan).
create or replace function public.vouchers_baperan_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_bp boolean; v_inv text;
begin
  select is_baperan into v_bp from public.voucher_types where id = new.voucher_type_id;
  select inventory into v_inv from public.accounts where id = new.account_id;
  if v_bp and coalesce(v_inv, '') <> 'baperan' then
    raise exception 'Voucher Baperan hanya dibuat lewat Restock Baperan (satu nomor telepon = satu akun Baperan), tidak dicampur dengan akun reguler';
  end if;
  if v_inv = 'baperan' and not v_bp then
    raise exception 'Akun Baperan hanya berisi voucher Baperan';
  end if;
  if v_inv = 'baperan' and exists (select 1 from public.vouchers where account_id = new.account_id) then
    raise exception 'Akun Baperan hanya berisi tepat 1 voucher';
  end if;
  return new;
end $$;
create trigger vouchers_baperan_guard before insert on public.vouchers
  for each row execute function public.vouchers_baperan_guard();

-- Voucher Baperan dari akun yang masa aktifnya lewat tidak bisa dipesan/dipakai untuk transaksi baru.
-- Masa aktif berlaku sampai akhir tanggalnya (WIB). Draft yang sudah dibuat sebelum lewat tetap bisa diselesaikan.
create or replace function public.vouchers_baperan_expiry_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_until date;
begin
  if old.status = 'available' and new.status in ('reserved', 'used') then
    select active_until into v_until from public.accounts where id = new.account_id and inventory = 'baperan';
    if v_until is not null and v_until < public.jkt_date(now()) then
      raise exception 'Akun Baperan untuk voucher % sudah kedaluwarsa (aktif s/d %). Pilih voucher lain.', new.code, to_char(v_until, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger vouchers_baperan_expiry_guard before update of status on public.vouchers
  for each row execute function public.vouchers_baperan_expiry_guard();

-- 3. Restock Baperan --------------------------------------------------------
-- Normalisasi nomor telepon: hanya angka, awalan 62 → 0.
create or replace function public._normalize_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '^62', '0')
$$;

create or replace function public.restock_baperan(
  p_phone text, p_pin text, p_unit_cost numeric, p_received_on date, p_active_until date, p_source_note text, p_idem uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.restocks; t public.voucher_types; v_phone text := public._normalize_phone(p_phone);
  v_pin text := nullif(trim(coalesce(p_pin, '')), ''); v_taken text; v_code text; v_acc uuid; v_key text;
  v_restock uuid; v_rcode text; v_voucher text; v_vid uuid;
begin
  perform public.require_active();
  select * into v_existing from public.restocks where idempotency_key = p_idem;
  if found then
    return jsonb_build_object('restock', v_existing.code, 'repeated', true,
      'account', (select account_code from public.accounts where id = v_existing.account_id),
      'voucher', (select code from public.vouchers where restock_id = v_existing.id limit 1));
  end if;
  if not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock' using errcode = '42501'; end if;

  select * into t from public.voucher_types where is_baperan and is_active order by brand_id limit 1;
  if not found then raise exception 'Jenis voucher Baperan belum dikonfigurasi atau nonaktif'; end if;

  if v_phone !~ '^08[0-9]{8,11}$' then raise exception 'Nomor telepon tidak valid (diawali 08, 10–13 digit)'; end if;
  select account_code into v_taken from public.accounts where account_number = v_phone;
  if found then raise exception 'Nomor % sudah terdaftar sebagai akun %', v_phone, v_taken using errcode = '23505'; end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN harus 4–8 angka'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Modal per voucher tidak boleh negatif'; end if;
  if p_received_on is null or p_received_on > public.jkt_date(now()) then raise exception 'Tanggal restock tidak valid'; end if;
  if p_active_until is null then raise exception 'Tanggal berakhir masa aktif wajib diisi'; end if;
  if p_active_until < p_received_on then raise exception 'Masa aktif tidak boleh berakhir sebelum tanggal restock'; end if;
  if length(trim(coalesce(p_source_note, ''))) < 3 then raise exception 'Isi sumber pembelian / penerimaan'; end if;

  -- ID akun otomatis & unik: BP-0001, BP-0002, … (dilewati bila sudah dipakai akun lain di brand ini).
  loop
    v_code := 'BP-' || lpad(nextval('public.baperan_seq')::text, 4, '0');
    exit when not exists (select 1 from public.accounts where brand_id = t.brand_id and account_key = v_code);
  end loop;

  insert into public.accounts (brand_id, account_code, source, account_number, active_until, inventory, pin, identity_note)
  values (t.brand_id, v_code, 'panel', v_phone, p_active_until, 'baperan', v_pin, null)
  returning id, account_key into v_acc, v_key;

  insert into public.restocks (source, kind, account_id, brand_id, items, idempotency_key, unit_cost, source_note, received_on)
  values ('panel', 'extra_only', v_acc, t.brand_id, jsonb_build_array(jsonb_build_object('type', t.code, 'qty', 1)),
          p_idem, p_unit_cost, trim(p_source_note), p_received_on)
  returning id, code into v_restock, v_rcode;

  v_voucher := 'V-' || public._voucher_base(t.brand_id, v_key) || '-' || t.code || '01';
  insert into public.vouchers (code, account_id, voucher_type_id, grp, slot, restock_id, allocated_cost)
  values (v_voucher, v_acc, t.id, t.grp, 1, v_restock, p_unit_cost)
  returning id into v_vid;
  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  values (v_vid, v_acc, 1, 'restock', 'available', v_rcode);

  -- PIN tidak ditulis ke audit; cukup tanda bahwa PIN diisi.
  perform public.write_audit('restock.baperan', 'accounts', v_acc::text, null,
    jsonb_build_object('restock', v_rcode, 'account', v_code, 'number', v_phone, 'voucher', v_voucher,
      'active_until', p_active_until, 'received_on', p_received_on, 'unit_cost', p_unit_cost,
      'source', trim(p_source_note), 'pin_set', v_pin is not null));
  return jsonb_build_object('restock', v_rcode, 'account', v_code, 'voucher', v_voucher, 'repeated', false);
end $$;

-- Owner memperbarui masa aktif / PIN akun Baperan. Wajib beralasan; tercatat di audit (nilai PIN tidak dicatat).
create or replace function public.owner_update_baperan(p_account uuid, p_active_until date, p_pin text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare a public.accounts; v_pin text := nullif(trim(coalesce(p_pin, '')), ''); v_received date;
begin
  perform public.require_owner();
  select * into a from public.accounts where id = p_account for update;
  if not found or a.inventory <> 'baperan' then raise exception 'Akun Baperan tidak ditemukan'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Isi alasan perubahan'; end if;
  if p_active_until is null then raise exception 'Tanggal berakhir masa aktif wajib diisi'; end if;
  select min(received_on) into v_received from public.restocks where account_id = a.id;
  if p_active_until < coalesce(v_received, public.jkt_date(a.entered_at)) then
    raise exception 'Masa aktif tidak boleh berakhir sebelum tanggal restock';
  end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN harus 4–8 angka'; end if;
  if p_active_until = a.active_until and v_pin is not distinct from a.pin then raise exception 'Tidak ada perubahan'; end if;

  update public.accounts set active_until = p_active_until, pin = v_pin where id = a.id;
  perform public.write_audit('account.baperan_update', 'accounts', a.id::text,
    jsonb_build_object('active_until', a.active_until, 'pin_set', a.pin is not null),
    jsonb_build_object('active_until', p_active_until, 'pin_set', v_pin is not null,
      'pin_changed', v_pin is distinct from a.pin, 'reason', trim(p_reason)));
end $$;

-- Hak eksekusi -------------------------------------------------------------
revoke all on function public.vouchers_baperan_guard(), public.vouchers_baperan_expiry_guard(), public._normalize_phone(text)
  from public, anon, authenticated;
revoke all on function public.restock_baperan(text, text, numeric, date, date, text, uuid),
  public.owner_update_baperan(uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.restock_baperan(text, text, numeric, date, date, text, uuid),
  public.owner_update_baperan(uuid, date, text, text) to authenticated;
revoke all on public.account_list from anon;
grant select on public.account_list to authenticated;
