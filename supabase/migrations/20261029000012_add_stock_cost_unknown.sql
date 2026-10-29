-- Tambah voucher ke akun yang ada: bila modal brand belum dikonfigurasi owner, modal voucher disimpan
-- "belum diisi" (NULL), bukan Rp0. Order dari voucher ini otomatis ditandai untuk ditinjau (lihat record_order).
-- Perilaku lain tidak berubah: modal per voucher tetap dipakai, brand gratis & modal per akun tetap Rp0.

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
              case when v_cost.id is null then null  -- modal brand belum dikonfigurasi: belum diisi
                   when v_cost.basis = 'rp_per_voucher' then v_cost.rp_per_voucher else 0 end);
    end loop;
  end loop;

  insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
  select id, v_acc.id, 1, 'restock', 'available', v_code from public.vouchers where restock_id = v_restock;
  perform public.write_audit('restock.add_stock', 'accounts', v_acc.id::text, null,
    jsonb_build_object('restock', v_code, 'items', p_items, 'cost_known', v_cost.id is not null));
  return v_code;
end $$;
