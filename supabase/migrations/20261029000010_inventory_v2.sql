-- Inventaris v2 (non-destruktif):
-- 1) ID akun fleksibel: 195678, 1234567, KK-195678. Disimpan sebagai teks (leading zero aman), prefix brand opsional.
-- 2) Restock voucher tambahan (Baperan) saja, tanpa akun baru & tanpa tiga voucher utama; akun opsional.
-- 3) Modal voucher boleh "belum diisi" (NULL), bukan otomatis Rp0.

-- 1. ID akun ----------------------------------------------------------------
alter table public.accounts drop constraint accounts_account_code_check;
alter table public.accounts drop constraint accounts_check;  -- dulu: 2 huruf pertama = brand
alter table public.accounts add constraint accounts_account_code_format
  check (account_code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and length(account_code) between 3 and 32);
-- Identitas akun tanpa prefix brand, agar "KK-195678" dan "195678" dianggap akun yang sama di brand yang sama.
alter table public.accounts add column account_key text
  generated always as (regexp_replace(account_code, '^' || brand_id || '-', '')) stored;
create unique index accounts_brand_key_unique on public.accounts (brand_id, account_key);

-- Rapikan input: huruf besar, tanpa spasi. Leading zero tetap (teks).
create or replace function public.normalize_account_code(p text) returns text
language sql immutable set search_path = '' as $$ select upper(regexp_replace(coalesce(p, ''), '\s', '', 'g')) $$;

create or replace function public._check_account_code(p_brand text, p_code text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_key text; v_existing text;
begin
  if p_code !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' or length(p_code) not between 3 and 32 then
    raise exception 'ID akun "%" tidak valid: gunakan 3–32 huruf/angka, tanda hubung hanya di tengah (mis. 195678 atau KK-195678)', p_code;
  end if;
  v_key := regexp_replace(p_code, '^' || p_brand || '-', '');
  select account_code into v_existing from public.accounts where brand_id = p_brand and account_key = v_key;
  if found then
    raise exception 'ID akun % sudah terdaftar di brand ini (tercatat sebagai %). Gunakan "Tambah voucher ke akun yang ada".', p_code, v_existing
      using errcode = '23505';
  end if;
  return v_key;
end $$;

-- Basis ID voucher: brand + identitas akun tanpa tanda hubung. Untuk ID lama "KK-0142" hasilnya tetap "KK0142".
create or replace function public._voucher_base(p_brand text, p_key text) returns text
language sql immutable set search_path = '' as $$ select p_brand || regexp_replace(p_key, '[^A-Z0-9]', '', 'g') $$;

-- 2. Kolom inventaris -------------------------------------------------------
alter type public.restock_kind add value if not exists 'extra_only';
alter table public.vouchers alter column account_id drop not null;
alter table public.vouchers alter column allocated_cost drop not null;  -- NULL = modal belum diisi
alter table public.restocks alter column account_id drop not null;
alter table public.stock_ledger alter column account_id drop not null;
alter table public.orders alter column account_id drop not null;
alter table public.restocks
  add column brand_id text references public.brands (id),
  add column unit_cost numeric(12, 2) check (unit_cost >= 0),  -- NULL = belum diisi
  add column source_note text,
  add column received_on date;
update public.restocks r set brand_id = a.brand_id from public.accounts a where a.id = r.account_id;

-- 3. Pembuatan akun (Panel & VM) dengan ID fleksibel -------------------------
create or replace function public._create_account(
  p_brand text, p_code text, p_source public.account_source, p_device text, p_number text,
  p_identity text, p_active_until date, p_manual jsonb, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text; v_brand public.brands; v_cost public.brand_costs; v_credit integer;
  v_alloc public.cost_allocation_settings; v_account uuid; v_restock uuid; v_restock_code text;
  v_account_cost numeric := 0; v_items jsonb := '[]'; v_total integer := 0; t record; v_qty integer; i integer;
  v_eligible integer; v_weight_sum numeric; v_key text; v_base text;
begin
  select code into v_existing from public.restocks where idempotency_key = p_idem;
  if found then return v_existing; end if;   -- kiriman ganda diabaikan

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'Brand % tidak dikenal', p_brand; end if;
  if p_source = 'vm' and not v_brand.vm_allowed then
    raise exception 'Brand % tidak dikelola lewat Virtual Machine', v_brand.name;
  end if;
  v_key := public._check_account_code(p_brand, p_code);
  v_base := public._voucher_base(p_brand, v_key);
  if p_number is not null and exists (select 1 from public.accounts where account_number = p_number) then
    raise exception 'Nomor akun sudah dipakai akun lain' using errcode = '23505';
  end if;

  select * into v_cost from public.brand_costs
  where brand_id = p_brand and effective_from <= now() order by effective_from desc limit 1;
  if not found then raise exception 'Modal brand % belum dikonfigurasi owner', v_brand.name; end if;
  v_credit := public.current_credit_price();
  if v_cost.basis = 'credit_per_account' then
    if v_credit is null then raise exception 'Harga kredit belum dikonfigurasi owner'; end if;
    v_account_cost := round(v_cost.credits_per_account * v_credit, 2);
  end if;
  select * into v_alloc from public.cost_allocation_settings where effective_from <= now() order by effective_from desc limit 1;

  for t in select * from public.voucher_types where brand_id = p_brand and is_active order by sort_order, code loop
    v_qty := coalesce(t.auto_per_account, coalesce((p_manual ->> t.code)::integer, 0));
    if v_qty < 0 or v_qty > 20 then raise exception 'Jumlah voucher % tidak valid', t.code; end if;
    if v_qty > 0 then
      v_items := v_items || jsonb_build_object('type', t.code, 'qty', v_qty);
      v_total := v_total + v_qty;
    end if;
  end loop;
  if v_total = 0 then raise exception 'Tidak ada voucher yang akan dibuat untuk akun ini'; end if;

  insert into public.accounts (brand_id, account_code, source, vm_device_id, account_number, identity_note, active_until)
  values (p_brand, p_code, p_source, p_device, p_number, nullif(trim(p_identity), ''), p_active_until)
  returning id into v_account;

  insert into public.restocks (source, kind, account_id, brand_id, vm_device_id, items, account_cost_rp, allocation_method, idempotency_key, received_on)
  values (p_source, 'new_account', v_account, p_brand, p_device, v_items, v_account_cost, coalesce(v_alloc.method, 'equal_main'), p_idem, public.jkt_date(now()))
  returning id, code into v_restock, v_restock_code;

  for t in select vt.*, (x ->> 'qty')::integer as qty
           from jsonb_array_elements(v_items) x
           join public.voucher_types vt on vt.brand_id = p_brand and vt.code = x ->> 'type' loop
    for i in 1 .. t.qty loop
      insert into public.vouchers (code, account_id, voucher_type_id, grp, slot, restock_id, allocated_cost)
      values ('V-' || v_base || '-' || t.code || case when t.auto_per_account = 1 then '' else lpad(i::text, 2, '0') end,
              v_account, t.id, t.grp, i, v_restock,
              case when v_cost.basis = 'rp_per_voucher' then v_cost.rp_per_voucher else 0 end);
    end loop;
  end loop;

  if v_account_cost > 0 then
    select count(*) into v_eligible from public.vouchers
    where restock_id = v_restock and (grp = 'main' or coalesce(v_alloc.extra_gets_cost, false));
    if v_eligible > 0 then
      if coalesce(v_alloc.method, 'equal_main') = 'weighted_max_discount' then
        select sum(coalesce(ver.max_discount, ver.fixed_discount, 1)) into v_weight_sum
        from public.vouchers v
        left join lateral public.current_voucher_version(v.voucher_type_id) ver on true
        where v.restock_id = v_restock and (v.grp = 'main' or coalesce(v_alloc.extra_gets_cost, false));
        update public.vouchers v set allocated_cost = round(v_account_cost * coalesce(
                 (select coalesce(ver.max_discount, ver.fixed_discount, 1) from public.current_voucher_version(v.voucher_type_id) ver), 1)
                 / v_weight_sum, 2)
        where v.restock_id = v_restock and (v.grp = 'main' or coalesce(v_alloc.extra_gets_cost, false));
      else
        update public.vouchers set allocated_cost = round(v_account_cost / v_eligible, 2)
        where restock_id = v_restock and (grp = 'main' or coalesce(v_alloc.extra_gets_cost, false));
      end if;
      update public.vouchers set allocated_cost = allocated_cost + (v_account_cost - (
               select sum(allocated_cost) from public.vouchers where restock_id = v_restock))
      where id = (select id from public.vouchers where restock_id = v_restock and allocated_cost > 0 order by code limit 1);
    end if;
  end if;

  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  select id, v_account, 1, 'restock', 'available', v_restock_code from public.vouchers where restock_id = v_restock;

  perform public.write_audit('account.create', 'accounts', v_account::text, null,
    jsonb_build_object('code', p_code, 'source', p_source, 'device', p_device, 'restock', v_restock_code, 'items', v_items));
  return v_restock_code;
end $$;

create or replace function public.panel_add_account(
  p_brand text, p_code text, p_identity text, p_active_until date, p_manual jsonb, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_active();
  if not public.can_restock_panel() then
    raise exception 'Akses ditolak: tidak punya izin restock Panel Admin' using errcode = '42501';
  end if;
  return public._create_account(p_brand, public.normalize_account_code(p_code), 'panel', null, null, p_identity, p_active_until,
                                coalesce(p_manual, '{}'), p_idem);
end $$;

-- VM: brand dari prefix bila ada (mis. KK-195678), selain itu brand VM yang berlaku (Kopi Kenangan).
create or replace function public.vm_add_account(
  p_device text, p_code text, p_number text, p_active_until date, p_manual jsonb, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text := public.normalize_account_code(p_code); v_brand text;
begin
  perform public.require_owner();
  if not exists (select 1 from public.vm_devices where id = p_device and is_active) then
    raise exception 'Virtual device % tidak aktif atau tidak ada', p_device;
  end if;
  select id into v_brand from public.brands where vm_allowed and v_code like id || '-%' limit 1;
  if v_brand is null then select id into v_brand from public.brands where vm_allowed order by id limit 1; end if;
  if v_brand is null then raise exception 'Belum ada brand yang dikelola lewat Virtual Machine'; end if;
  return public._create_account(v_brand, v_code, 'vm', p_device, regexp_replace(p_number, '[^0-9]', '', 'g'),
                                null, p_active_until, coalesce(p_manual, '{}'), p_idem);
end $$;

-- 4. Tambah voucher ke akun yang ada (ID voucher memakai basis baru) -------
create or replace function public.add_stock(p_account uuid, p_items jsonb, p_idem uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text; v_acc public.accounts; v_cost public.brand_costs;
  v_restock uuid; v_code text; x jsonb; t public.voucher_types; v_qty integer; v_slot integer; i integer; v_base text;
begin
  perform public.require_active();
  select code into v_existing from public.restocks where idempotency_key = p_idem;
  if found then return v_existing; end if;

  select * into v_acc from public.accounts where id = p_account for update;
  if not found then raise exception 'Akun tidak ditemukan'; end if;
  if v_acc.source = 'vm' then perform public.require_owner();
  elsif not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Isi minimal satu jenis voucher'; end if;
  v_base := public._voucher_base(v_acc.brand_id, v_acc.account_key);

  select * into v_cost from public.brand_costs where brand_id = v_acc.brand_id and effective_from <= now()
  order by effective_from desc limit 1;

  insert into public.restocks (source, kind, account_id, brand_id, vm_device_id, items, idempotency_key, received_on)
  values (v_acc.source, 'add_stock', v_acc.id, v_acc.brand_id, v_acc.vm_device_id, p_items, p_idem, public.jkt_date(now()))
  returning id, code into v_restock, v_code;

  for x in select * from jsonb_array_elements(p_items) loop
    select * into t from public.voucher_types where brand_id = v_acc.brand_id and code = x ->> 'type' and is_active;
    if not found then raise exception 'Jenis voucher % tidak ada untuk brand ini', x ->> 'type'; end if;
    if t.auto_per_account is not null then
      raise exception 'Voucher % dibuat otomatis per akun dan tidak dibuat ulang', t.name;
    end if;
    v_qty := (x ->> 'qty')::integer;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'Jumlah voucher % tidak valid', t.code; end if;
    select coalesce(max(slot), 0) into v_slot from public.vouchers where account_id = v_acc.id and voucher_type_id = t.id;
    for i in 1 .. v_qty loop
      insert into public.vouchers (code, account_id, voucher_type_id, grp, slot, restock_id, allocated_cost)
      values ('V-' || v_base || '-' || t.code || lpad((v_slot + i)::text, 2, '0'),
              v_acc.id, t.id, t.grp, v_slot + i, v_restock,
              case when v_cost.basis = 'rp_per_voucher' then v_cost.rp_per_voucher else 0 end);
    end loop;
  end loop;

  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  select id, v_acc.id, 1, 'restock', 'available', v_code from public.vouchers where restock_id = v_restock;
  perform public.write_audit('restock.add_stock', 'accounts', v_acc.id::text, null, jsonb_build_object('restock', v_code, 'items', p_items));
  return v_code;
end $$;

-- 5. Restock voucher tambahan saja (mis. Baperan dari pihak lain) -----------
create or replace function public.restock_extra_only(
  p_type uuid, p_qty integer, p_account uuid, p_unit_cost numeric, p_source_note text, p_received_on date, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text; t public.voucher_types; v_acc public.accounts; v_restock uuid; v_code text; v_slot integer := 0;
  v_base text; i integer;
begin
  perform public.require_active();
  select code into v_existing from public.restocks where idempotency_key = p_idem;
  if found then return v_existing; end if;
  if not public.can_restock_panel() then raise exception 'Akses ditolak: tidak punya izin restock' using errcode = '42501'; end if;

  select * into t from public.voucher_types where id = p_type and is_active;
  if not found then raise exception 'Jenis voucher tidak ditemukan atau nonaktif'; end if;
  if t.grp <> 'extra' or t.auto_per_account is not null then
    raise exception 'Restock terpisah hanya untuk voucher tambahan (mis. Baperan), bukan voucher utama';
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 200 then raise exception 'Jumlah voucher 1–200'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Modal per voucher tidak boleh negatif'; end if;
  if length(trim(coalesce(p_source_note, ''))) < 3 then raise exception 'Isi sumber pembelian / penerimaan'; end if;
  if p_received_on is null or p_received_on > public.jkt_date(now()) then raise exception 'Tanggal restock tidak valid'; end if;

  if p_account is not null then
    select * into v_acc from public.accounts where id = p_account for update;
    if not found then raise exception 'Akun tidak ditemukan'; end if;
    if v_acc.brand_id <> t.brand_id then raise exception 'Akun dan jenis voucher berbeda brand'; end if;
    if v_acc.source = 'vm' then perform public.require_owner(); end if;
    select coalesce(max(slot), 0) into v_slot from public.vouchers where account_id = v_acc.id and voucher_type_id = t.id;
  end if;

  insert into public.restocks (source, kind, account_id, brand_id, vm_device_id, items, idempotency_key, unit_cost, source_note, received_on)
  values (coalesce(v_acc.source, 'panel'), 'extra_only', v_acc.id, t.brand_id, v_acc.vm_device_id,
          jsonb_build_array(jsonb_build_object('type', t.code, 'qty', p_qty)), p_idem, p_unit_cost, trim(p_source_note), p_received_on)
  returning id, code into v_restock, v_code;

  -- ID voucher: terikat akun → lanjut nomor di akun; lepas → nomor lot restock.
  v_base := case when v_acc.id is not null then public._voucher_base(v_acc.brand_id, v_acc.account_key)
                 else t.brand_id || 'LOT' || regexp_replace(v_code, '[^0-9]', '', 'g') end;
  for i in 1 .. p_qty loop
    insert into public.vouchers (code, account_id, voucher_type_id, grp, slot, restock_id, allocated_cost)
    values ('V-' || v_base || '-' || t.code || lpad((v_slot + i)::text, 2, '0'), v_acc.id, t.id, t.grp, v_slot + i, v_restock, p_unit_cost);
  end loop;

  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  select id, v_acc.id, 1, 'restock', 'available', v_code from public.vouchers where restock_id = v_restock;
  perform public.write_audit('restock.extra_only', 'restocks', v_restock::text, null,
    jsonb_build_object('restock', v_code, 'type', t.code, 'qty', p_qty, 'account', v_acc.account_code, 'unit_cost', p_unit_cost, 'source', p_source_note));
  return v_code;
end $$;

-- Owner mengisi modal yang tadinya "belum diisi". Order lama tidak berubah (HPP tersimpan di order).
create or replace function public.set_restock_unit_cost(p_restock uuid, p_unit_cost numeric) returns integer
language plpgsql security definer set search_path = '' as $$
declare r public.restocks; v_n integer;
begin
  perform public.require_owner();
  select * into r from public.restocks where id = p_restock for update;
  if not found or r.kind <> 'extra_only' then raise exception 'Restock tidak ditemukan'; end if;
  if r.unit_cost is not null then raise exception 'Modal restock ini sudah diisi'; end if;
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'Isi modal per voucher (boleh Rp0 bila gratis)'; end if;
  update public.restocks set unit_cost = p_unit_cost where id = r.id;
  update public.vouchers set allocated_cost = p_unit_cost where restock_id = r.id and allocated_cost is null;
  get diagnostics v_n = row_count;
  perform public.write_audit('restock.set_unit_cost', 'restocks', r.id::text, jsonb_build_object('unit_cost', null),
    jsonb_build_object('unit_cost', p_unit_cost, 'vouchers', v_n));
  return v_n;
end $$;

-- 6. Order: voucher tanpa akun & modal belum diisi --------------------------
create or replace function public.record_order(
  p_voucher uuid, p_customer_name text, p_customer_wa text, p_ref text,
  p_menu_price integer, p_sell_price integer, p_extra_cost integer,
  p_manual_discount integer, p_price_after_override integer, p_confirm boolean, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text; v public.vouchers; vt public.voucher_types; ver public.voucher_type_versions;
  v_cost public.brand_costs;
  v_discount integer; v_after integer; v_manual boolean := false; v_reasons text[] := '{}';
  v_hpp numeric; v_gross numeric; v_net numeric; v_code text; v_order uuid; v_alloc numeric;
  v_wa text := regexp_replace(coalesce(p_customer_wa, ''), '[\s-]', '', 'g');
begin
  perform public.require_active();
  select code into v_existing from public.orders where idempotency_key = p_idem;
  if found then return v_existing; end if;

  select * into v from public.vouchers where id = p_voucher for update;   -- kunci voucher
  if not found then raise exception 'Voucher tidak ditemukan'; end if;
  if v.status <> 'available' then
    raise exception 'Voucher % tidak tersedia (status: %). Pilih voucher lain.', v.code, v.status using errcode = '23505';
  end if;
  select * into vt from public.voucher_types where id = v.voucher_type_id;
  ver := public.current_voucher_version(vt.id);
  select * into v_cost from public.brand_costs where brand_id = vt.brand_id and effective_from <= now()
  order by effective_from desc limit 1;

  if coalesce(trim(p_customer_name), '') = '' then raise exception 'Nama customer wajib diisi'; end if;
  if v_wa !~ '^(\+62|62|0)8[0-9]{8,11}$' then raise exception 'Nomor WhatsApp tidak valid'; end if;
  if p_menu_price is null or p_menu_price <= 0 then raise exception 'Harga asli menu wajib diisi'; end if;
  if ver.min_purchase is not null and p_menu_price < ver.min_purchase then
    raise exception 'Harga asli di bawah minimum pembelian voucher (Rp%)', ver.min_purchase;
  end if;

  if ver.fixed_discount is not null then
    v_discount := least(ver.fixed_discount, p_menu_price);
  elsif ver.discount_pct is not null then
    v_discount := round(p_menu_price * ver.discount_pct / 100);
    if ver.max_discount is not null then
      v_discount := least(v_discount, ver.max_discount);
    else
      v_reasons := array_append(v_reasons, 'Batas potongan belum dikonfigurasi');
    end if;
  else
    if p_manual_discount is null then
      raise exception 'Ketentuan voucher % belum dikonfigurasi: isi potongan manual', vt.name;
    end if;
    v_discount := p_manual_discount;
    v_manual := true;
    v_reasons := array_append(v_reasons, 'Potongan manual (ketentuan belum dikonfigurasi)');
  end if;
  if v_discount < 0 or v_discount > p_menu_price then raise exception 'Potongan tidak valid'; end if;
  v_after := p_menu_price - v_discount;
  if p_price_after_override is not null and p_price_after_override <> v_after then
    v_reasons := array_append(v_reasons, 'Harga merchant berbeda dari hitungan voucher');
    v_after := p_price_after_override;
  end if;

  -- Modal belum diisi: dihitung Rp0 di order ini, order ditandai untuk ditinjau owner.
  v_alloc := coalesce(v.allocated_cost, 0);
  if v.allocated_cost is null then v_reasons := array_append(v_reasons, 'Modal voucher belum diisi'); end if;

  v_hpp := v_after + v_alloc;
  v_gross := p_sell_price - v_hpp;
  v_net := v_gross - coalesce(p_extra_cost, 0);
  v_code := 'TRX-' || to_char(now() at time zone 'Asia/Jakarta', 'YYMMDD') || '-' || lpad(nextval('public.order_seq')::text, 4, '0');

  insert into public.orders (code, ref_order, account_id, voucher_id, voucher_type_version_id, customer_name, customer_wa,
    menu_price, discount, manual_discount, price_after_discount, sell_price, extra_cost, allocated_cost, hpp,
    gross_profit, net_profit, rule_snapshot, credit_price_snapshot, needs_review, review_reasons, status,
    idempotency_key, confirmed_at)
  values (v_code, nullif(trim(p_ref), ''), v.account_id, v.id, ver.id, trim(p_customer_name), v_wa,
    p_menu_price, v_discount, v_manual, v_after, p_sell_price, coalesce(p_extra_cost, 0), v_alloc, v_hpp,
    v_gross, v_net,
    jsonb_build_object('voucher_type', vt.code, 'voucher_name', vt.name, 'version_id', ver.id,
      'discount_pct', ver.discount_pct, 'fixed_discount', ver.fixed_discount, 'min_purchase', ver.min_purchase,
      'max_discount', ver.max_discount, 'cost_basis', v_cost.basis, 'credits_per_account', v_cost.credits_per_account,
      'rp_per_voucher', v_cost.rp_per_voucher, 'voucher_cost_known', v.allocated_cost is not null),
    public.current_credit_price(), cardinality(v_reasons) > 0, v_reasons,
    case when p_confirm then 'confirmed'::public.order_status else 'draft'::public.order_status end,
    p_idem, case when p_confirm then now() end)
  returning id into v_order;

  if p_confirm then
    update public.vouchers set status = 'used' where id = v.id;
    insert into public.voucher_usages (voucher_id, order_id, customer_name, customer_wa, admin_id)
    values (v.id, v_order, trim(p_customer_name), v_wa, auth.uid());
    insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
    values (v.id, v.account_id, -1, 'use', 'used', v_code);
  else
    update public.vouchers set status = 'reserved' where id = v.id;
    insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
    values (v.id, v.account_id, 0, 'reserve', 'reserved', v_code);
  end if;

  perform public.write_audit(case when p_confirm then 'order.confirm' else 'order.draft' end, 'orders', v_order::text, null,
    jsonb_build_object('code', v_code, 'voucher', v.code, 'net_profit', v_net));
  return v_code;
end $$;

-- Hak eksekusi -------------------------------------------------------------
revoke all on function public._check_account_code(text, text), public._voucher_base(text, text),
  public.restock_extra_only(uuid, integer, uuid, numeric, text, date, uuid), public.set_restock_unit_cost(uuid, numeric),
  public.normalize_account_code(text) from public, anon, authenticated;
grant execute on function public.restock_extra_only(uuid, integer, uuid, numeric, text, date, uuid),
  public.set_restock_unit_cost(uuid, numeric) to authenticated;
