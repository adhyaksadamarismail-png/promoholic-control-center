-- Fungsi server untuk akun, restock (VM & Panel), order, pembatalan, dan koreksi stok.
-- Semua SECURITY DEFINER dengan search_path kosong; peran selalu dicek dari sesi.

create or replace function public.jkt_date(ts timestamptz) returns date
language sql immutable set search_path = '' as $$ select (ts at time zone 'Asia/Jakarta')::date $$;

create or replace function public.current_credit_price(p_at timestamptz default now()) returns integer
language sql stable security definer set search_path = '' as $$
  select rp_per_credit from public.credit_prices where effective_from <= p_at order by effective_from desc limit 1
$$;

create or replace function public.current_voucher_version(p_type uuid, p_at timestamptz default now())
returns public.voucher_type_versions
language sql stable security definer set search_path = '' as $$
  select * from public.voucher_type_versions
  where voucher_type_id = p_type and effective_from <= p_at
  order by effective_from desc limit 1
$$;

create or replace function public.can_restock_panel() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.is_active and (p.role = 'owner' or p.can_restock_panel))
$$;

-- Inti pembuatan akun: hanya dipanggil oleh panel_add_account / vm_add_account (tidak di-grant ke klien).
create or replace function public._create_account(
  p_brand text, p_code text, p_source public.account_source, p_device text, p_number text,
  p_identity text, p_active_until date, p_manual jsonb, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text;
  v_brand public.brands;
  v_cost public.brand_costs;
  v_credit integer;
  v_alloc public.cost_allocation_settings;
  v_account uuid;
  v_restock uuid;
  v_restock_code text;
  v_account_cost numeric := 0;
  v_items jsonb := '[]';
  v_total integer := 0;
  t record;
  v_qty integer;
  i integer;
  v_eligible integer;
  v_weight_sum numeric;
begin
  select code into v_existing from public.restocks where idempotency_key = p_idem;
  if found then return v_existing; end if;   -- kiriman ganda diabaikan

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'Brand % tidak dikenal', p_brand; end if;
  if left(p_code, 2) <> p_brand then raise exception 'Format ID akun harus %-0000', p_brand; end if;
  if p_source = 'vm' and not v_brand.vm_allowed then
    raise exception 'Brand % tidak dikelola lewat Virtual Machine', v_brand.name;
  end if;
  if exists (select 1 from public.accounts where brand_id = p_brand and account_code = p_code) then
    raise exception 'ID akun % sudah terdaftar. Gunakan penambahan stok untuk akun yang sudah ada.', p_code using errcode = '23505';
  end if;
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

  -- Jumlah per jenis: jenis otomatis memakai aturan brand; jenis tanpa aturan memakai input restock.
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

  insert into public.restocks (source, kind, account_id, vm_device_id, items, account_cost_rp, allocation_method, idempotency_key)
  values (p_source, 'new_account', v_account, p_device, v_items, v_account_cost, coalesce(v_alloc.method, 'equal_main'), p_idem)
  returning id, code into v_restock, v_restock_code;

  for t in select vt.*, (x ->> 'qty')::integer as qty
           from jsonb_array_elements(v_items) x
           join public.voucher_types vt on vt.brand_id = p_brand and vt.code = x ->> 'type' loop
    for i in 1 .. t.qty loop
      insert into public.vouchers (code, account_id, voucher_type_id, grp, slot, restock_id, allocated_cost)
      values ('V-' || replace(p_code, '-', '') || '-' || t.code ||
                case when t.auto_per_account = 1 then '' else lpad(i::text, 2, '0') end,
              v_account, t.id, t.grp, i, v_restock,
              case when v_cost.basis = 'rp_per_voucher' then v_cost.rp_per_voucher else 0 end);
    end loop;
  end loop;

  -- Modal akun dicatat sekali, lalu dibagi ke voucher yang berhak (default: voucher utama saja).
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
      -- Sisa pembulatan masuk ke satu voucher agar total alokasi = modal akun.
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

-- Panel Admin: staf berizin & owner. Tidak menerima akun VM.
create or replace function public.panel_add_account(
  p_brand text, p_code text, p_identity text, p_active_until date, p_manual jsonb, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_active();
  if not public.can_restock_panel() then
    raise exception 'Akses ditolak: tidak punya izin restock Panel Admin' using errcode = '42501';
  end if;
  return public._create_account(p_brand, upper(trim(p_code)), 'panel', null, null, p_identity, p_active_until,
                                coalesce(p_manual, '{}'), p_idem);
end $$;

-- Virtual Machine: khusus owner, dicek di database.
create or replace function public.vm_add_account(
  p_device text, p_code text, p_number text, p_active_until date, p_manual jsonb, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(trim(p_code));
begin
  perform public.require_owner();
  if not exists (select 1 from public.vm_devices where id = p_device and is_active) then
    raise exception 'Virtual device % tidak aktif atau tidak ada', p_device;
  end if;
  return public._create_account(left(v_code, 2), v_code, 'vm', p_device, regexp_replace(p_number, '[^0-9]', '', 'g'),
                                null, p_active_until, coalesce(p_manual, '{}'), p_idem);
end $$;

create or replace function public.vm_add_device(p_name text, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id text;
begin
  perform public.require_owner();
  select 'VD-' || lpad((coalesce(max(substring(id from 4)::integer), 0) + 1)::text, 2, '0') into v_id from public.vm_devices;
  insert into public.vm_devices (id, name, note) values (v_id, trim(p_name), p_note);
  perform public.write_audit('vm_device.create', 'vm_devices', v_id, null, jsonb_build_object('name', p_name));
  return v_id;
end $$;

-- Ubah data akun VM tanpa menyentuh voucher (voucher utama tidak dibuat ulang).
create or replace function public.vm_update_account(p_account uuid, p_number text, p_device text, p_active_until date)
returns void language plpgsql security definer set search_path = '' as $$
declare v_before public.accounts;
begin
  perform public.require_owner();
  select * into v_before from public.accounts where id = p_account and source = 'vm' for update;
  if not found then raise exception 'Akun VM tidak ditemukan'; end if;
  update public.accounts set account_number = regexp_replace(p_number, '[^0-9]', '', 'g'),
                             vm_device_id = p_device, active_until = p_active_until
  where id = p_account;
  perform public.write_audit('account.update', 'accounts', p_account::text, to_jsonb(v_before),
    (select to_jsonb(a) from public.accounts a where a.id = p_account));
end $$;

-- Tambah stok ke akun yang sudah ada: hanya jenis tanpa jumlah otomatis (mis. Baperan, Fore, Starbucks).
create or replace function public.add_stock(p_account uuid, p_items jsonb, p_idem uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text; v_acc public.accounts; v_cost public.brand_costs;
  v_restock uuid; v_code text; x jsonb; t public.voucher_types; v_qty integer; v_slot integer; i integer;
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

  select * into v_cost from public.brand_costs where brand_id = v_acc.brand_id and effective_from <= now()
  order by effective_from desc limit 1;

  insert into public.restocks (source, kind, account_id, vm_device_id, items, idempotency_key)
  values (v_acc.source, 'add_stock', v_acc.id, v_acc.vm_device_id, p_items, p_idem)
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
      values ('V-' || replace(v_acc.account_code, '-', '') || '-' || t.code || lpad((v_slot + i)::text, 2, '0'),
              v_acc.id, t.id, t.grp, v_slot + i, v_restock,
              case when v_cost.basis = 'rp_per_voucher' then v_cost.rp_per_voucher else 0 end);
    end loop;
  end loop;

  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  select id, v_acc.id, 1, 'restock', 'available', v_code from public.vouchers where restock_id = v_restock;
  perform public.write_audit('restock.add_stock', 'accounts', v_acc.id::text, null, jsonb_build_object('restock', v_code, 'items', p_items));
  return v_code;
end $$;

-- Catat order. Potongan dihitung dari versi aturan voucher yang berlaku; nilai NULL = belum dikonfigurasi.
create or replace function public.record_order(
  p_voucher uuid, p_customer_name text, p_customer_wa text, p_ref text,
  p_menu_price integer, p_sell_price integer, p_extra_cost integer,
  p_manual_discount integer, p_price_after_override integer, p_confirm boolean, p_idem uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_existing text; v public.vouchers; vt public.voucher_types; ver public.voucher_type_versions; acc public.accounts;
  v_cost public.brand_costs;
  v_discount integer; v_after integer; v_manual boolean := false; v_reasons text[] := '{}';
  v_hpp numeric; v_gross numeric; v_net numeric; v_code text; v_order uuid;
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
  select * into acc from public.accounts where id = v.account_id;
  select * into vt from public.voucher_types where id = v.voucher_type_id;
  ver := public.current_voucher_version(vt.id);
  select * into v_cost from public.brand_costs where brand_id = acc.brand_id and effective_from <= now()
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

  v_hpp := v_after + v.allocated_cost;
  v_gross := p_sell_price - v_hpp;
  v_net := v_gross - coalesce(p_extra_cost, 0);
  v_code := 'TRX-' || to_char(now() at time zone 'Asia/Jakarta', 'YYMMDD') || '-' || lpad(nextval('public.order_seq')::text, 4, '0');

  insert into public.orders (code, ref_order, account_id, voucher_id, voucher_type_version_id, customer_name, customer_wa,
    menu_price, discount, manual_discount, price_after_discount, sell_price, extra_cost, allocated_cost, hpp,
    gross_profit, net_profit, rule_snapshot, credit_price_snapshot, needs_review, review_reasons, status,
    idempotency_key, confirmed_at)
  values (v_code, nullif(trim(p_ref), ''), acc.id, v.id, ver.id, trim(p_customer_name), v_wa,
    p_menu_price, v_discount, v_manual, v_after, p_sell_price, coalesce(p_extra_cost, 0), v.allocated_cost, v_hpp,
    v_gross, v_net,
    jsonb_build_object('voucher_type', vt.code, 'voucher_name', vt.name, 'version_id', ver.id,
      'discount_pct', ver.discount_pct, 'fixed_discount', ver.fixed_discount, 'min_purchase', ver.min_purchase,
      'max_discount', ver.max_discount, 'cost_basis', v_cost.basis, 'credits_per_account', v_cost.credits_per_account,
      'rp_per_voucher', v_cost.rp_per_voucher),
    public.current_credit_price(), cardinality(v_reasons) > 0, v_reasons,
    case when p_confirm then 'confirmed'::public.order_status else 'draft'::public.order_status end,
    p_idem, case when p_confirm then now() end)
  returning id into v_order;

  if p_confirm then
    update public.vouchers set status = 'used' where id = v.id;
    insert into public.voucher_usages (voucher_id, order_id, customer_name, customer_wa, admin_id)
    values (v.id, v_order, trim(p_customer_name), v_wa, auth.uid());
    insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
    values (v.id, acc.id, -1, 'use', 'used', v_code);
  else
    update public.vouchers set status = 'reserved' where id = v.id;
    insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
    values (v.id, acc.id, 0, 'reserve', 'reserved', v_code);
  end if;

  perform public.write_audit(case when p_confirm then 'order.confirm' else 'order.draft' end, 'orders', v_order::text, null,
    jsonb_build_object('code', v_code, 'voucher', v.code, 'net_profit', v_net));
  return v_code;
end $$;

create or replace function public.confirm_draft(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  perform public.require_active();
  select * into o from public.orders where id = p_order for update;
  if not found or o.status <> 'draft' then raise exception 'Draft tidak ditemukan'; end if;
  if not (public.is_owner() or o.admin_id = auth.uid()) then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  perform 1 from public.vouchers where id = o.voucher_id and status = 'reserved' for update;
  if not found then raise exception 'Voucher draft tidak lagi dipesan'; end if;
  update public.orders set status = 'confirmed', confirmed_at = now() where id = o.id;
  update public.vouchers set status = 'used' where id = o.voucher_id;
  insert into public.voucher_usages (voucher_id, order_id, customer_name, customer_wa, admin_id)
  values (o.voucher_id, o.id, o.customer_name, o.customer_wa, o.admin_id);
  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  values (o.voucher_id, o.account_id, -1, 'use', 'used', o.code);
  perform public.write_audit('order.confirm_draft', 'orders', o.id::text, null, null);
end $$;

create or replace function public.cancel_draft(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  perform public.require_active();
  select * into o from public.orders where id = p_order for update;
  if not found or o.status <> 'draft' then raise exception 'Draft tidak ditemukan'; end if;
  if not (public.is_owner() or o.admin_id = auth.uid()) then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  update public.orders set status = 'cancelled', cancelled_at = now() where id = o.id;
  update public.vouchers set status = 'available' where id = o.voucher_id;
  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  values (o.voucher_id, o.account_id, 0, 'release', 'available', o.code);
  perform public.write_audit('order.cancel_draft', 'orders', o.id::text, null, null);
end $$;

create or replace function public.request_order_cancel(p_order uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_id uuid;
begin
  perform public.require_active();
  select * into o from public.orders where id = p_order;
  if not found or o.status <> 'confirmed' then raise exception 'Hanya order terkonfirmasi yang bisa diajukan batal'; end if;
  if not (public.is_owner() or o.admin_id = auth.uid()) then raise exception 'Akses ditolak' using errcode = '42501'; end if;
  insert into public.approval_requests (kind, target_id, reason) values ('order_cancel', o.id, p_reason) returning id into v_id;
  perform public.write_audit('order.cancel_request', 'orders', o.id::text, null, jsonb_build_object('reason', p_reason));
  return v_id;
end $$;

create or replace function public.request_stock_adjust(p_voucher uuid, p_new_status public.voucher_status, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.require_active();
  if p_new_status not in ('available', 'expired', 'broken') then raise exception 'Status koreksi tidak valid'; end if;
  if not exists (select 1 from public.vouchers where id = p_voucher and status in ('available', 'expired', 'broken')) then
    raise exception 'Voucher terpakai/dipesan tidak dikoreksi lewat jalur ini; gunakan pembatalan order';
  end if;
  insert into public.approval_requests (kind, target_id, payload, reason)
  values ('stock_adjust', p_voucher, jsonb_build_object('new_status', p_new_status), p_reason) returning id into v_id;
  return v_id;
end $$;
