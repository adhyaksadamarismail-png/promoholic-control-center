-- Baperan lanjutan (non-destruktif):
-- 1) Sumber pembelian/penerimaan Baperan opsional.
-- 2) Bulk Restock Baperan: satu baris = nomor telepon | PIN; masa aktif, tanggal restock, modal, dan sumber berlaku
--    untuk seluruh batch. Memakai tabel & riwayat batch yang sama dengan Bulk Restock reguler (mode 'baperan').
-- 3) Voucher Baperan: minimum pembelian Rp17.000 (versi ketentuan baru; order lama tetap memakai snapshot-nya).

-- 1. Pembuatan satu akun Baperan (inti bersama restock satuan & bulk; tidak di-grant ke klien) ---------------
create or replace function public._create_baperan(
  p_phone text, p_pin text, p_unit_cost numeric, p_received_on date, p_active_until date, p_source_note text,
  p_idem uuid, p_batch uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.voucher_types; v_phone text := public._normalize_phone(p_phone);
  v_pin text := nullif(trim(coalesce(p_pin, '')), ''); v_note text := nullif(trim(coalesce(p_source_note, '')), '');
  v_taken text; v_code text; v_acc uuid; v_key text; v_restock uuid; v_rcode text; v_voucher text; v_vid uuid;
begin
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

  -- ID akun otomatis & unik: BP-0001, BP-0002, … (dilewati bila sudah dipakai akun lain di brand ini).
  loop
    v_code := 'BP-' || lpad(nextval('public.baperan_seq')::text, 4, '0');
    exit when not exists (select 1 from public.accounts where brand_id = t.brand_id and account_key = v_code);
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
      'active_until', p_active_until, 'received_on', p_received_on, 'unit_cost', p_unit_cost,
      'source', v_note, 'pin_set', v_pin is not null, 'batch', p_batch));
  return jsonb_build_object('restock', v_rcode, 'account', v_code, 'voucher', v_voucher, 'repeated', false);
end $$;

-- Restock satu akun: kini sumber pembelian opsional. Perilaku lain sama.
create or replace function public.restock_baperan(
  p_phone text, p_pin text, p_unit_cost numeric, p_received_on date, p_active_until date, p_source_note text, p_idem uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_existing public.restocks;
begin
  perform public.require_active();
  select * into v_existing from public.restocks where idempotency_key = p_idem;
  if found then
    return jsonb_build_object('restock', v_existing.code, 'repeated', true,
      'account', (select account_code from public.accounts where id = v_existing.account_id),
      'voucher', (select code from public.vouchers where restock_id = v_existing.id limit 1));
  end if;
  if not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock' using errcode = '42501'; end if;
  return public._create_baperan(p_phone, p_pin, p_unit_cost, p_received_on, p_active_until, p_source_note, p_idem, null);
end $$;

-- 2. Bulk Restock Baperan ---------------------------------------------------
alter table public.restock_batches drop constraint restock_batches_mode_check;
alter table public.restock_batches add constraint restock_batches_mode_check
  check (mode in ('new_account', 'add_stock', 'extra_only', 'baperan'));

-- Validasi tanpa menulis apa pun. p_rows: [{"line": 1, "number": "0812...", "pin": "123456"}]
create or replace function public.bulk_restock_baperan_validate(p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; v_out jsonb := '[]'; v_err text; v_phone text; v_pin text; v_taken text; v_seen text[] := '{}';
begin
  perform public.require_active();
  if not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock Panel Admin' using errcode = '42501'; end if;
  if not exists (select 1 from public.voucher_types where is_baperan and is_active) then
    raise exception 'Jenis voucher Baperan belum dikonfigurasi atau nonaktif';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Tidak ada baris data'; end if;
  if jsonb_array_length(p_rows) > 300 then raise exception 'Maksimal 300 baris per batch'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_err := null; v_taken := null;
    v_phone := public._normalize_phone(r ->> 'number');
    v_pin := nullif(trim(coalesce(r ->> 'pin', '')), '');
    if v_phone !~ '^08[0-9]{8,11}$' then v_err := 'Nomor telepon tidak valid (diawali 08, 10–13 digit)';
    elsif v_phone = any (v_seen) then v_err := 'Nomor duplikat di batch ini';
    else
      select account_code into v_taken from public.accounts where account_number = v_phone;
      if v_taken is not null then v_err := 'Nomor sudah terdaftar sebagai akun ' || v_taken; end if;
    end if;
    if v_err is null and v_pin is not null and v_pin !~ '^[0-9]{4,8}$' then v_err := 'PIN harus 4–8 angka'; end if;
    if v_phone ~ '^08[0-9]{8,11}$' then v_seen := array_append(v_seen, v_phone); end if;
    -- Nilai PIN tidak dikembalikan; cukup tanda ada/tidak.
    v_out := v_out || jsonb_build_object('line', r -> 'line', 'ok', v_err is null, 'error', v_err, 'kind', 'new',
      'number', nullif(v_phone, ''), 'pin_set', v_pin is not null,
      'counts', case when v_err is null then jsonb_build_object('BP', 1) else '{}'::jsonb end, 'total', case when v_err is null then 1 else 0 end);
  end loop;
  return v_out;
end $$;

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
      'rows', public._restock_batch_rows(v_existing.id));
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
      md5(p_idem::text || ':' || (r ->> 'line'))::uuid, v_batch);
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
    'rows', public._restock_batch_rows(v_batch));
end $$;

-- 3. Ketentuan Baperan: Rp8.000, minimum pembelian Rp17.000 ---------------------------------------------------
-- Versi baru hanya ditambahkan bila versi yang berlaku masih Rp8.000 tanpa minimum (tidak menimpa ketentuan lain).
do $$
declare t uuid; cur public.voucher_type_versions; v uuid;
begin
  for t in select id from public.voucher_types where is_baperan loop
    cur := public.current_voucher_version(t);
    if cur.id is not null and cur.fixed_discount = 8000 and cur.min_purchase is null then
      insert into public.voucher_type_versions (voucher_type_id, fixed_discount, min_purchase, max_discount, b1g1_terms, validity_note, effective_from)
      values (t, 8000, 17000, cur.max_discount, cur.b1g1_terms, cur.validity_note, now())
      returning id into v;
      perform public.write_audit('voucher_type.version', 'voucher_type_versions', v::text,
        jsonb_build_object('fixed_discount', 8000, 'min_purchase', null),
        jsonb_build_object('fixed_discount', 8000, 'min_purchase', 17000, 'note', 'Baperan: minimum pembelian Rp17.000'));
    end if;
  end loop;
end $$;

-- Hak eksekusi -------------------------------------------------------------
revoke all on function public._create_baperan(text, text, numeric, date, date, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.bulk_restock_baperan_validate(jsonb),
  public.bulk_restock_baperan(jsonb, date, date, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.bulk_restock_baperan_validate(jsonb),
  public.bulk_restock_baperan(jsonb, date, date, numeric, text, uuid) to authenticated;
