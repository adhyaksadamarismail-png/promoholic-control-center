-- Baperan dengan dua metode identitas (non-destruktif, tanpa tabel/kolom baru, tanpa perubahan data):
-- 1) Nomor telepon (seperti sekarang): nomor wajib, PIN opsional, ID akun otomatis BP-0001.
-- 2) ID Akun: identitas internal website sumber, disimpan sebagai account_code BP-197865. Tanpa nomor telepon & tanpa PIN.
-- Metode terbaca dari data: account_number NULL = akun ber-ID. Format baris bulk lama tetap diterima, jadi versi
-- aplikasi yang sedang berjalan tetap bekerja setelah migration ini.

-- 1. Aturan kolom -----------------------------------------------------------
alter table public.accounts drop constraint accounts_source_fields;
alter table public.accounts add constraint accounts_source_fields check (
  (source = 'vm' and inventory = 'regular' and vm_device_id is not null and account_number is not null)
  or (source = 'panel' and inventory = 'regular' and vm_device_id is null and account_number is null and pin is null)
  or (source = 'panel' and inventory = 'baperan' and vm_device_id is null and active_until is not null
      and (account_number is not null or (pin is null and account_code ~ '^BP-[0-9]+$')))
);

-- 2. Normalisasi ------------------------------------------------------------
-- Nomor telepon: hanya angka, awalan 62 → 0, dan angka 0 di depan yang hilang (umum dari Excel) dikembalikan.
create or replace function public._normalize_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    regexp_replace(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '^62', '0'),
    '^(8[0-9]{8,11})$', '0\1')
$$;

-- ID Akun: awalan BP dilepas lebih dulu supaya tidak pernah tertulis dua kali (197865, BP-197865, bp197865 → 197865).
create or replace function public._normalize_baperan_id(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(upper(trim(coalesce(p, ''))), '^BP-?', '')
$$;

-- Alasan penolakan ID Akun (NULL = valid). Satu sumber untuk validasi bulk dan pembuatan akun.
create or replace function public._baperan_id_error(p_id text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_id ~ '^(08|628)[0-9]{8,}$' then 'Ini terlihat seperti nomor telepon. Pilih metode Nomor Telepon'
    when p_id !~ '^[0-9]{4,16}$' then 'ID akun harus berupa angka, 4–16 digit'
  end
$$;

-- 3. Pembuatan satu akun Baperan --------------------------------------------
drop function public._create_baperan(text, text, numeric, date, date, text, uuid, uuid);
create function public._create_baperan(
  p_phone text, p_pin text, p_unit_cost numeric, p_received_on date, p_active_until date, p_source_note text,
  p_idem uuid, p_batch uuid, p_account_id text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.voucher_types; v_phone text; v_id text := public._normalize_baperan_id(p_account_id);
  v_pin text := nullif(trim(coalesce(p_pin, '')), ''); v_note text := nullif(trim(coalesce(p_source_note, '')), '');
  v_taken text; v_code text; v_acc uuid; v_key text; v_restock uuid; v_rcode text; v_voucher text; v_vid uuid;
begin
  select * into t from public.voucher_types where is_baperan and is_active order by brand_id limit 1;
  if not found then raise exception 'Jenis voucher Baperan belum dikonfigurasi atau nonaktif'; end if;

  if p_account_id is not null then
    if public._baperan_id_error(v_id) is not null then raise exception '%', public._baperan_id_error(v_id); end if;
    if v_pin is not null then raise exception 'ID Akun tidak memakai PIN'; end if;
    v_code := 'BP-' || v_id;
    if exists (select 1 from public.accounts where brand_id = t.brand_id and account_key = v_code) then
      raise exception 'ID akun % sudah terdaftar', v_code using errcode = '23505';
    end if;
  else
    v_phone := public._normalize_phone(p_phone);
    if v_phone !~ '^08[0-9]{8,11}$' then raise exception 'Nomor telepon tidak valid (diawali 08, 10–13 digit)'; end if;
    select account_code into v_taken from public.accounts where account_number = v_phone;
    if found then raise exception 'Nomor % sudah terdaftar sebagai akun %', v_phone, v_taken using errcode = '23505'; end if;
    if v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN harus 4–8 angka'; end if;
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Modal per voucher tidak boleh negatif'; end if;
  if p_received_on is null or p_received_on > public.jkt_date(now()) then raise exception 'Tanggal restock tidak valid'; end if;
  if p_active_until is null then raise exception 'Tanggal berakhir masa aktif wajib diisi'; end if;
  if p_active_until < p_received_on then raise exception 'Masa aktif tidak boleh berakhir sebelum tanggal restock'; end if;

  -- Metode telepon: ID akun otomatis & unik, BP-0001, BP-0002, … (dilewati bila sudah dipakai akun lain di brand ini).
  while v_code is null loop
    v_code := 'BP-' || lpad(nextval('public.baperan_seq')::text, 4, '0');
    if exists (select 1 from public.accounts where brand_id = t.brand_id and account_key = v_code) then v_code := null; end if;
  end loop;

  insert into public.accounts (brand_id, account_code, source, account_number, active_until, inventory, pin, identity_note)
  values (t.brand_id, v_code, 'panel', v_phone, p_active_until, 'baperan', v_pin, null)
  returning id, account_key into v_acc, v_key;

  insert into public.restocks (source, kind, account_id, brand_id, items, idempotency_key, unit_cost, source_note, received_on, batch_id)
  values ('panel', 'extra_only', v_acc, t.brand_id, jsonb_build_array(jsonb_build_object('type', t.code, 'qty', 1)),
          p_idem, p_unit_cost, v_note, p_received_on, p_batch)
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
      'identity', case when p_account_id is not null then 'account_id' else 'phone' end,
      'active_until', p_active_until, 'received_on', p_received_on, 'unit_cost', p_unit_cost,
      'source', v_note, 'pin_set', v_pin is not null, 'batch', p_batch));
  return jsonb_build_object('restock', v_rcode, 'account', v_code, 'voucher', v_voucher, 'repeated', false);
end $$;

-- 4. Bulk Restock Baperan ---------------------------------------------------
-- p_rows: [{"line": 1, "number": "0812...", "pin": "123456"}] atau [{"line": 1, "account_id": "197865"}].
create or replace function public.bulk_restock_baperan_validate(p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb; v_out jsonb := '[]'; v_err text; v_phone text; v_id text; v_code text; v_pin text; v_taken text; v_key text;
  v_seen text[] := '{}'; v_brand text;
begin
  perform public.require_active();
  if not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock Panel Admin' using errcode = '42501'; end if;
  select brand_id into v_brand from public.voucher_types where is_baperan and is_active order by brand_id limit 1;
  if not found then raise exception 'Jenis voucher Baperan belum dikonfigurasi atau nonaktif'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Tidak ada baris data'; end if;
  if jsonb_array_length(p_rows) > 300 then raise exception 'Maksimal 300 baris per batch'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_err := null; v_taken := null; v_phone := null; v_code := null; v_key := null;
    v_pin := nullif(trim(coalesce(r ->> 'pin', '')), '');

    if r ->> 'account_id' is not null then
      v_id := public._normalize_baperan_id(r ->> 'account_id');
      v_err := public._baperan_id_error(v_id);
      if v_err is null then
        v_code := 'BP-' || v_id;
        v_key := v_code;
        if v_key = any (v_seen) then v_err := 'ID duplikat di batch ini';
        elsif exists (select 1 from public.accounts a where a.brand_id = v_brand and a.account_key = v_code) then
          v_err := 'ID akun ' || v_code || ' sudah terdaftar';
        elsif v_pin is not null then v_err := 'ID Akun tidak memakai PIN';
        end if;
      end if;
    else
      v_phone := public._normalize_phone(r ->> 'number');
      if v_phone !~ '^08[0-9]{8,11}$' then v_err := 'Nomor telepon tidak valid (diawali 08, 10–13 digit)';
      else
        v_key := v_phone;
        if v_key = any (v_seen) then v_err := 'Nomor duplikat di batch ini';
        else
          select account_code into v_taken from public.accounts where account_number = v_phone;
          if v_taken is not null then v_err := 'Nomor sudah terdaftar sebagai akun ' || v_taken; end if;
        end if;
      end if;
      if v_err is null and v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then v_err := 'PIN harus 4–8 angka'; end if;
    end if;
    if v_key is not null then v_seen := array_append(v_seen, v_key); end if;

    -- Nilai PIN tidak dikembalikan; cukup tanda ada/tidak.
    v_out := v_out || jsonb_build_object('line', r -> 'line', 'ok', v_err is null, 'error', v_err, 'kind', 'new',
      'number', nullif(v_phone, ''), 'code', v_code, 'pin_set', v_pin is not null and v_code is null,
      'counts', case when v_err is null then jsonb_build_object('BP', 1) else '{}'::jsonb end, 'total', case when v_err is null then 1 else 0 end);
  end loop;
  return v_out;
end $$;

-- Hasil per baris batch Baperan: kunci idempotensi baris diturunkan dari kunci batch + nomor baris.
create or replace function public._baperan_batch_rows(p_batch uuid, p_idem uuid, p_rows jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'line', (x ->> 'line')::int, 'restock', rs.code, 'account', a.account_code, 'account_key', a.account_key,
           'items', rs.items, 'vouchers', (select count(*) from public.vouchers v where v.restock_id = rs.id))
         order by (x ->> 'line')::int), '[]')
  from jsonb_array_elements(p_rows) x
  join public.restocks rs on rs.batch_id = p_batch and rs.idempotency_key = md5(p_idem::text || ':' || (x ->> 'line'))::uuid
  left join public.accounts a on a.id = rs.account_id
$$;

-- Simpan satu batch (atomik): hanya bila semua baris yang dikirim valid. Kiriman ganda mengembalikan batch yang sama.
create or replace function public.bulk_restock_baperan(
  p_rows jsonb, p_active_until date, p_received_on date, p_unit_cost numeric, p_source_note text, p_idem uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.restock_batches; v_rows jsonb; r jsonb; v_batch uuid; v_bcode text; b public.restock_batches;
  v_bad text;
begin
  perform public.require_active();
  select * into v_existing from public.restock_batches where idempotency_key = p_idem;
  if found then
    return jsonb_build_object('batch', v_existing.code, 'new_accounts', v_existing.new_accounts, 'vouchers', v_existing.voucher_count,
      'total_cost', v_existing.total_cost, 'cost_unknown', v_existing.cost_unknown, 'repeated', true,
      'rows', public._baperan_batch_rows(v_existing.id, p_idem, p_rows));
  end if;
  if p_active_until is null then raise exception 'Tanggal berakhir masa aktif wajib diisi'; end if;
  if p_received_on is null or p_received_on > public.jkt_date(now()) then raise exception 'Tanggal restock tidak valid'; end if;
  if p_active_until < p_received_on then raise exception 'Masa aktif tidak boleh berakhir sebelum tanggal restock'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Modal per voucher tidak boleh negatif'; end if;

  v_rows := public.bulk_restock_baperan_validate(p_rows);  -- juga memeriksa izin
  select string_agg('Baris ' || (x ->> 'line') || ': ' || (x ->> 'error'), '; ') into v_bad
  from jsonb_array_elements(v_rows) x where not (x ->> 'ok')::boolean;
  if v_bad is not null then raise exception 'Batch tidak disimpan. %', v_bad; end if;

  insert into public.restock_batches (source, mode, brand_id, row_count, source_note, idempotency_key)
  select 'panel', 'baperan', t.brand_id, jsonb_array_length(v_rows), nullif(trim(coalesce(p_source_note, '')), ''), p_idem
  from public.voucher_types t where t.is_baperan and t.is_active order by t.brand_id limit 1
  returning id, code into v_batch, v_bcode;

  for r in select * from jsonb_array_elements(p_rows) loop
    -- Kunci idempotensi per baris diturunkan dari kunci batch + nomor baris (stabil bila dikirim ulang).
    perform public._create_baperan(r ->> 'number', r ->> 'pin', p_unit_cost, p_received_on, p_active_until, p_source_note,
      md5(p_idem::text || ':' || (r ->> 'line'))::uuid, v_batch, r ->> 'account_id');
  end loop;

  update public.restock_batches bt set
    new_accounts = (select count(*) from public.restocks rs where rs.batch_id = v_batch),
    voucher_count = (select count(*) from public.vouchers v join public.restocks rs on rs.id = v.restock_id where rs.batch_id = v_batch),
    total_cost = (select coalesce(sum(v.allocated_cost), 0) from public.vouchers v join public.restocks rs on rs.id = v.restock_id where rs.batch_id = v_batch),
    cost_unknown = (select count(*) from public.vouchers v join public.restocks rs on rs.id = v.restock_id where rs.batch_id = v_batch and v.allocated_cost is null)
  where bt.id = v_batch
  returning * into b;

  perform public.write_audit('restock.bulk', 'restock_batches', v_batch::text, null,
    jsonb_build_object('batch', v_bcode, 'source', 'panel', 'mode', 'baperan', 'rows', b.row_count, 'new_accounts', b.new_accounts,
      'vouchers', b.voucher_count, 'total_cost', b.total_cost, 'active_until', p_active_until, 'received_on', p_received_on));
  return jsonb_build_object('batch', b.code, 'new_accounts', b.new_accounts, 'vouchers', b.voucher_count,
    'total_cost', b.total_cost, 'cost_unknown', b.cost_unknown, 'repeated', false,
    'rows', public._baperan_batch_rows(v_batch, p_idem, p_rows));
end $$;

-- 5. Akun ber-ID tidak bisa diberi PIN --------------------------------------
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
  if a.account_number is null and v_pin is not null then raise exception 'ID Akun tidak memakai PIN'; end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN harus 4–8 angka'; end if;
  if p_active_until = a.active_until and v_pin is not distinct from a.pin then raise exception 'Tidak ada perubahan'; end if;

  update public.accounts set active_until = p_active_until, pin = v_pin where id = a.id;
  perform public.write_audit('account.baperan_update', 'accounts', a.id::text,
    jsonb_build_object('active_until', a.active_until, 'pin_set', a.pin is not null),
    jsonb_build_object('active_until', p_active_until, 'pin_set', v_pin is not null,
      'pin_changed', v_pin is distinct from a.pin, 'reason', trim(p_reason)));
end $$;

-- Hak eksekusi -------------------------------------------------------------
revoke all on function public._create_baperan(text, text, numeric, date, date, text, uuid, uuid, text),
  public._normalize_baperan_id(text), public._baperan_id_error(text), public._baperan_batch_rows(uuid, uuid, jsonb)
  from public, anon, authenticated;
