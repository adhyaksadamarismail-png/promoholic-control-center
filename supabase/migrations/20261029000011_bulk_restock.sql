-- Bulk restock: banyak akun/voucher sekaligus dari Panel Admin atau Virtual Machine (owner).
-- Satu batch = satu transaksi: bila satu baris gagal saat disimpan, seluruh batch dibatalkan.
-- Memakai ulang fungsi restock yang sudah ada sehingga aturan brand, modal, ID voucher, dan audit tetap sama.

create sequence public.restock_batch_seq;
create table public.restock_batches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('BAT-' || lpad(nextval('public.restock_batch_seq')::text, 6, '0')),
  source public.account_source not null,
  mode text not null check (mode in ('new_account', 'add_stock', 'extra_only')),
  brand_id text references public.brands (id),
  row_count integer not null default 0,
  new_accounts integer not null default 0,
  voucher_count integer not null default 0,
  total_cost numeric(12, 2) not null default 0,   -- jumlah modal voucher yang diketahui
  cost_unknown integer not null default 0,         -- voucher dengan modal "belum diisi"
  status text not null default 'completed' check (status in ('completed')),
  source_note text,
  idempotency_key uuid not null unique,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);
alter table public.restocks add column batch_id uuid references public.restock_batches (id);
create index restocks_batch_idx on public.restocks (batch_id);

alter table public.restock_batches enable row level security;
revoke all on public.restock_batches from anon;
revoke insert, update, delete on public.restock_batches from authenticated;
grant select on public.restock_batches to authenticated;
-- Sama dengan restocks: staf hanya melihat batch Panel; batch VM khusus owner.
create policy restock_batches_read on public.restock_batches for select to authenticated
  using (public.is_owner() or (public.is_active_user() and source = 'panel'));

-- Validasi tanpa menulis apa pun (dipakai untuk preview dan diulang saat menyimpan).
-- p_rows: [{"line": 1, "device": "VD-01", "code": "195678", "number": "0857...", "items": {"A": 1, "BP": 2}}]
create or replace function public.bulk_restock_validate(p_source text, p_mode text, p_brand text, p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb; v_out jsonb := '[]'; v_err text; v_code text; v_key text; v_brand text; v_device text; v_number text;
  v_acc public.accounts; t public.voucher_types; k text; v_qty integer; v_counts jsonb; v_total integer; v_kind text;
  v_seen_keys text[] := '{}'; v_seen_numbers text[] := '{}';
begin
  if p_source not in ('panel', 'vm') then raise exception 'Sumber restock tidak valid'; end if;
  if p_mode not in ('new_account', 'add_stock', 'extra_only') then raise exception 'Jenis restock tidak valid'; end if;
  if p_source = 'vm' then perform public.require_owner();
  else
    perform public.require_active();
    if not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock Panel Admin' using errcode = '42501'; end if;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Tidak ada baris data'; end if;
  if jsonb_array_length(p_rows) > 300 then raise exception 'Maksimal 300 baris per batch'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_err := null; v_acc := null; v_counts := '{}'; v_total := 0; v_kind := null; v_key := null; v_number := null;
    v_code := nullif(public.normalize_account_code(r ->> 'code'), '');
    v_device := nullif(upper(regexp_replace(coalesce(r ->> 'device', ''), '^\s*VM-', 'VD-', 'i')), '');

    -- Brand: Panel memakai brand pilihan; VM memakai prefix ID (bila brand VM) atau brand VM yang berlaku.
    if p_source = 'vm' then
      select id into v_brand from public.brands where vm_allowed and coalesce(v_code, '') like id || '-%' limit 1;
      if v_brand is null then select id into v_brand from public.brands where vm_allowed order by id limit 1; end if;
    else
      v_brand := p_brand;
    end if;
    if v_brand is null or not exists (select 1 from public.brands where id = v_brand) then v_err := 'Brand belum dipilih atau tidak dikenal'; end if;

    -- ID akun
    if v_err is null and v_code is not null then
      if v_code !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' or length(v_code) not between 3 and 32 then
        v_err := 'ID akun tidak valid (3–32 huruf/angka, mis. 195678 atau KK-195678)';
      else
        v_key := regexp_replace(v_code, '^' || v_brand || '-', '');
        if v_key = any (v_seen_keys) then v_err := 'ID akun duplikat di batch ini'; end if;
        v_seen_keys := array_append(v_seen_keys, v_key);
        select * into v_acc from public.accounts where brand_id = v_brand and account_key = v_key;
      end if;
    end if;

    if v_err is null then
      if p_mode = 'new_account' then
        if v_code is null then v_err := 'ID akun wajib diisi';
        elsif v_acc.id is not null then v_err := 'ID akun sudah terdaftar (' || v_acc.account_code || '): gunakan "Tambah voucher ke akun yang sudah ada"';
        end if;
        v_kind := 'new';
      elsif p_mode = 'add_stock' then
        if v_code is null then v_err := 'ID akun wajib diisi';
        elsif v_acc.id is null then v_err := 'Akun belum terdaftar: gunakan "Akun baru"';
        elsif v_acc.source::text <> p_source then
          v_err := case when v_acc.source = 'vm' then 'Akun ini dari Virtual Machine: tambah voucher lewat modul VM (owner)' else 'Akun ini dari Panel Admin: tambah voucher lewat Panel Admin' end;
        end if;
        v_kind := 'existing';
      else
        if v_code is not null and v_acc.id is null then v_err := 'Akun belum terdaftar. Kosongkan ID untuk Baperan lepas';
        elsif v_acc.id is not null and v_acc.source::text <> p_source then
          v_err := case when v_acc.source = 'vm' then 'Akun ini dari Virtual Machine: restock lewat modul VM (owner)' else 'Akun ini dari Panel Admin: restock lewat Panel Admin' end;
        end if;
        v_kind := case when v_acc.id is null then 'lot' else 'existing' end;
      end if;
    end if;

    -- Device & nomor akun: hanya untuk akun baru di VM.
    if v_err is null and p_source = 'vm' and p_mode = 'new_account' then
      v_number := regexp_replace(coalesce(r ->> 'number', ''), '[^0-9]', '', 'g');
      if v_device is null then v_err := 'ID virtual device wajib diisi';
      elsif not exists (select 1 from public.vm_devices where id = v_device and is_active) then v_err := 'Virtual device ' || v_device || ' tidak ada atau nonaktif';
      elsif v_number !~ '^08[0-9]{8,11}$' then v_err := 'Nomor akun VM wajib diisi (diawali 08, 10–13 digit)';
      elsif v_number = any (v_seen_numbers) then v_err := 'Nomor akun duplikat di batch ini';
      elsif exists (select 1 from public.accounts where account_number = v_number) then v_err := 'Nomor akun sudah dipakai akun lain';
      end if;
      v_seen_numbers := array_append(v_seen_numbers, v_number);
    elsif v_err is null and p_source = 'panel' and (nullif(r ->> 'number', '') is not null or v_device is not null) then
      v_err := 'Nomor akun & device hanya untuk Virtual Machine';
    end if;

    -- Jenis voucher sesuai konfigurasi brand (tidak mengarang aturan untuk brand lain).
    if v_err is null then
      if p_mode = 'new_account' then
        for t in select * from public.voucher_types where brand_id = v_brand and is_active and auto_per_account is not null loop
          v_counts := v_counts || jsonb_build_object(t.code, t.auto_per_account);
          v_total := v_total + t.auto_per_account;
        end loop;
      end if;
      for k in select * from jsonb_object_keys(coalesce(r -> 'items', '{}')) loop
        exit when v_err is not null;
        v_qty := nullif(r -> 'items' ->> k, '')::integer;
        select * into t from public.voucher_types where brand_id = v_brand and code = upper(k) and is_active;
        if not found then v_err := 'Jenis voucher ' || upper(k) || ' tidak ada untuk brand ini';
        elsif v_qty is null or v_qty < 0 or v_qty > 20 then v_err := 'Jumlah ' || t.code || ' harus 0–20';
        elsif t.auto_per_account is not null then
          if p_mode <> 'new_account' then v_err := 'Voucher utama ' || t.code || ' dibuat otomatis saat akun baru dan tidak dibuat ulang';
          elsif v_qty <> t.auto_per_account then v_err := 'Voucher utama ' || t.code || ' selalu ' || t.auto_per_account || ' per akun baru';
          end if;
        elsif p_mode = 'extra_only' and t.grp <> 'extra' then v_err := 'Mode Baperan saja hanya untuk voucher tambahan';
        elsif v_qty > 0 then
          v_counts := v_counts || jsonb_build_object(t.code, v_qty);
          v_total := v_total + v_qty;
        end if;
      end loop;
      if v_err is null and v_total = 0 then v_err := 'Tidak ada voucher yang akan dibuat'; end if;
    end if;

    v_out := v_out || jsonb_build_object('line', r -> 'line', 'ok', v_err is null, 'error', v_err, 'kind', v_kind,
      'brand', v_brand, 'code', v_code, 'device', v_device, 'number', nullif(v_number, ''),
      'account', v_acc.id, 'counts', v_counts, 'total', v_total);
  end loop;
  return v_out;
end $$;

create or replace function public.bulk_restock(
  p_source text, p_mode text, p_brand text, p_rows jsonb, p_unit_cost numeric, p_source_note text, p_idem uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.restock_batches; v_rows jsonb; r jsonb; v_batch uuid; v_bcode text; v_restock text; k text; v_type uuid;
  v_new integer := 0; v_items jsonb; v_manual jsonb; b public.restock_batches;
begin
  select * into v_existing from public.restock_batches where idempotency_key = p_idem;
  if found then  -- kiriman ganda: kembalikan batch yang sudah tersimpan, tanpa menyimpan ulang
    return jsonb_build_object('batch', v_existing.code, 'new_accounts', v_existing.new_accounts, 'vouchers', v_existing.voucher_count,
      'total_cost', v_existing.total_cost, 'cost_unknown', v_existing.cost_unknown, 'repeated', true);
  end if;
  if p_mode = 'extra_only' and length(trim(coalesce(p_source_note, ''))) < 3 then raise exception 'Isi sumber pembelian / penerimaan'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Modal per voucher tidak boleh negatif'; end if;

  -- Validasi ulang di server; batch hanya disimpan bila semua baris yang dikirim valid.
  v_rows := public.bulk_restock_validate(p_source, p_mode, p_brand, p_rows);
  if exists (select 1 from jsonb_array_elements(v_rows) x where not (x ->> 'ok')::boolean) then
    raise exception 'Baris % tidak valid: %',
      (select x ->> 'line' from jsonb_array_elements(v_rows) x where not (x ->> 'ok')::boolean limit 1),
      (select x ->> 'error' from jsonb_array_elements(v_rows) x where not (x ->> 'ok')::boolean limit 1);
  end if;

  insert into public.restock_batches (source, mode, brand_id, row_count, source_note, idempotency_key)
  values (p_source::public.account_source, p_mode, case when p_source = 'panel' then p_brand end, jsonb_array_length(v_rows),
          nullif(trim(coalesce(p_source_note, '')), ''), p_idem)
  returning id, code into v_batch, v_bcode;

  for r in select * from jsonb_array_elements(v_rows) loop
    -- Jumlah voucher non-otomatis untuk baris ini (voucher utama otomatis dibuat oleh fungsi akun baru).
    v_manual := '{}'; v_items := '[]';
    for k in select * from jsonb_object_keys(r -> 'counts') loop
      if exists (select 1 from public.voucher_types where brand_id = r ->> 'brand' and code = k and auto_per_account is null) then
        v_manual := v_manual || jsonb_build_object(k, (r -> 'counts' ->> k)::integer);
        v_items := v_items || jsonb_build_object('type', k, 'qty', (r -> 'counts' ->> k)::integer);
      end if;
    end loop;

    if p_mode = 'new_account' then
      v_restock := case when p_source = 'vm'
        then public.vm_add_account(r ->> 'device', r ->> 'code', r ->> 'number', null, v_manual, gen_random_uuid())
        else public.panel_add_account(r ->> 'brand', r ->> 'code', null, null, v_manual, gen_random_uuid()) end;
      v_new := v_new + 1;
      update public.restocks set batch_id = v_batch where code = v_restock;
    elsif p_mode = 'add_stock' then
      v_restock := public.add_stock((r ->> 'account')::uuid, v_items, gen_random_uuid());
      update public.restocks set batch_id = v_batch where code = v_restock;
    else
      for k in select * from jsonb_object_keys(r -> 'counts') loop
        select id into v_type from public.voucher_types where brand_id = r ->> 'brand' and code = k;
        v_restock := public.restock_extra_only(v_type, (r -> 'counts' ->> k)::integer, nullif(r ->> 'account', '')::uuid,
                                               p_unit_cost, p_source_note, public.jkt_date(now()), gen_random_uuid());
        update public.restocks set batch_id = v_batch where code = v_restock;
      end loop;
    end if;
  end loop;

  -- Ringkasan dihitung dari voucher yang benar-benar dibuat (modal mengikuti konfigurasi yang berlaku saat ini).
  update public.restock_batches bt set
    new_accounts = v_new,
    voucher_count = (select count(*) from public.vouchers v join public.restocks rs on rs.id = v.restock_id where rs.batch_id = v_batch),
    total_cost = (select coalesce(sum(v.allocated_cost), 0) from public.vouchers v join public.restocks rs on rs.id = v.restock_id where rs.batch_id = v_batch),
    cost_unknown = (select count(*) from public.vouchers v join public.restocks rs on rs.id = v.restock_id where rs.batch_id = v_batch and v.allocated_cost is null)
  where bt.id = v_batch
  returning * into b;

  perform public.write_audit('restock.bulk', 'restock_batches', v_batch::text, null,
    jsonb_build_object('batch', v_bcode, 'source', p_source, 'mode', p_mode, 'rows', b.row_count, 'new_accounts', b.new_accounts,
                       'vouchers', b.voucher_count, 'total_cost', b.total_cost));
  return jsonb_build_object('batch', b.code, 'new_accounts', b.new_accounts, 'vouchers', b.voucher_count,
    'total_cost', b.total_cost, 'cost_unknown', b.cost_unknown, 'repeated', false);
end $$;

revoke all on function public.bulk_restock_validate(text, text, text, jsonb),
  public.bulk_restock(text, text, text, jsonb, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.bulk_restock_validate(text, text, text, jsonb),
  public.bulk_restock(text, text, text, jsonb, numeric, text, uuid) to authenticated;
