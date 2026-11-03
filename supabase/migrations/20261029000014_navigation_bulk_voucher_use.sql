-- 1) Satu pemeriksaan profil per request untuk navigasi (layout & halaman), tanpa menunggu getUser dulu.
-- 2) Bulk restock mengembalikan hasil per akun (juga saat kiriman ganda), untuk ditampilkan setelah simpan.
-- 3) Owner mengatur "jumlah otomatis per akun baru" untuk voucher utama, dengan audit.
-- 4) Owner membatalkan pemakaian voucher (order) langsung dengan alasan, lewat jalur persetujuan yang sama.

-- 1. Profil pengguna yang sedang login (aktif saja). Identitas dari JWT; sesi tetap diverifikasi getUser di aplikasi.
create or replace function public.current_profile()
returns table (id uuid, full_name text, role public.app_role, must_change_password boolean, can_restock_panel boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, p.role, p.must_change_password, p.can_restock_panel
  from public.profiles p where p.id = auth.uid() and p.is_active
$$;
revoke all on function public.current_profile() from public, anon, authenticated;
grant execute on function public.current_profile() to authenticated;

-- 2. Hasil per akun dalam satu batch: kode restock, akun, jumlah voucher per jenis.
create or replace function public._restock_batch_rows(p_batch uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'restock', rs.code, 'account', a.account_code, 'account_key', a.account_key, 'items', rs.items,
           'vouchers', (select count(*) from public.vouchers v where v.restock_id = rs.id))
         order by rs.code), '[]')
  from public.restocks rs left join public.accounts a on a.id = rs.account_id
  where rs.batch_id = p_batch
$$;
revoke all on function public._restock_batch_rows(uuid) from public, anon, authenticated;

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
      'total_cost', v_existing.total_cost, 'cost_unknown', v_existing.cost_unknown, 'repeated', true,
      'rows', public._restock_batch_rows(v_existing.id));
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
    'total_cost', b.total_cost, 'cost_unknown', b.cost_unknown, 'repeated', false,
    'rows', public._restock_batch_rows(v_batch));
end $$;

revoke all on function public.bulk_restock(text, text, text, jsonb, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.bulk_restock(text, text, text, jsonb, numeric, text, uuid) to authenticated;

-- 3. Jumlah voucher utama yang dibuat otomatis per akun baru. NULL = diisi manual saat restock.
-- Hanya untuk akun yang dibuat setelah perubahan; voucher tambahan (mis. Baperan) tetap direstock terpisah.
create or replace function public.set_voucher_type_auto(p_type uuid, p_auto integer) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.voucher_types;
begin
  perform public.require_owner();
  select * into t from public.voucher_types where id = p_type for update;
  if not found then raise exception 'Jenis voucher tidak ditemukan'; end if;
  if t.grp <> 'main' then
    raise exception 'Jumlah otomatis hanya untuk voucher utama; voucher tambahan (mis. Baperan) direstock terpisah';
  end if;
  if p_auto is not null and (p_auto < 1 or p_auto > 10) then raise exception 'Jumlah otomatis 1–10, atau kosongkan untuk diisi manual'; end if;
  if t.auto_per_account is not distinct from p_auto then return; end if;
  update public.voucher_types set auto_per_account = p_auto where id = t.id;
  perform public.write_audit('voucher_type.set_auto', 'voucher_types', t.id::text,
    jsonb_build_object('auto_per_account', t.auto_per_account),
    jsonb_build_object('type', t.brand_id || '-' || t.code, 'auto_per_account', p_auto));
end $$;
revoke all on function public.set_voucher_type_auto(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_voucher_type_auto(uuid, integer) to authenticated;

-- 4. Owner membatalkan order (pemakaian voucher) langsung. Memakai decide_approval yang sama dengan jalur staf,
-- sehingga voucher kembali tersedia, histori pemakaian tetap tercatat, dan semuanya masuk audit.
create or replace function public.cancel_order_now(p_order uuid, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_req uuid;
begin
  perform public.require_owner();
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Tulis alasan pembatalan'; end if;
  select * into o from public.orders where id = p_order;
  if not found or o.status <> 'confirmed' then raise exception 'Hanya order terkonfirmasi yang bisa dibatalkan'; end if;
  select id into v_req from public.approval_requests where kind = 'order_cancel' and target_id = o.id and status = 'pending';
  if v_req is null then
    insert into public.approval_requests (kind, target_id, reason) values ('order_cancel', o.id, trim(p_reason)) returning id into v_req;
  end if;
  perform public.decide_approval(v_req, true, 'Dibatalkan langsung oleh owner: ' || trim(p_reason));
  return o.code;
end $$;
revoke all on function public.cancel_order_now(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_order_now(uuid, text) to authenticated;
