-- Hapus akun (satu atau banyak) oleh owner. Akun yang punya transaksi atau histori selain restock ditolak,
-- sehingga histori keuangan tidak pernah terhapus. Akun yang aman dihapus beserta voucher, restock, dan entri
-- stok "restock"-nya. Setiap akun diproses dalam savepoint sendiri; satu entri audit per operasi.

-- Riwayat stok tetap append-only. Satu-satunya pengecualian: entri "restock" milik akun yang sedang dihapus
-- oleh delete_accounts (penanda transaksi-lokal yang hanya diset fungsi itu).
create or replace function public.stock_ledger_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.reason = 'restock'
     and old.account_id::text = current_setting('app.deleting_account', true) then
    return old;
  end if;
  raise exception 'Tabel % hanya boleh ditambah (append-only)', tg_table_name using errcode = '42501';
end $$;
drop trigger stock_ledger_append_only on public.stock_ledger;
create trigger stock_ledger_append_only before update or delete on public.stock_ledger
  for each row execute function public.stock_ledger_guard();

create or replace function public.delete_accounts(p_accounts uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; a public.accounts; v_reason text; v_vouchers integer; v_restocks text[];
  v_results jsonb := '[]'; v_deleted jsonb := '[]'; v_skipped jsonb := '[]';
begin
  perform public.require_owner();
  if coalesce(cardinality(p_accounts), 0) = 0 then raise exception 'Pilih minimal satu akun'; end if;
  if cardinality(p_accounts) > 200 then raise exception 'Maksimal 200 akun per penghapusan'; end if;

  foreach v_id in array (select array_agg(distinct x) from unnest(p_accounts) x) loop
    v_reason := null;
    begin
      select * into a from public.accounts where id = v_id for update;
      if not found then
        v_reason := 'Akun tidak ditemukan';
      else
        perform 1 from public.vouchers where account_id = a.id for update;  -- cegah order bersamaan
        if exists (select 1 from public.orders o where o.account_id = a.id
                   or o.voucher_id in (select id from public.vouchers where account_id = a.id)) then
          v_reason := 'Akun punya transaksi (order); histori keuangan tidak dihapus';
        elsif exists (select 1 from public.vouchers where account_id = a.id and status <> 'available') then
          v_reason := 'Ada voucher yang tidak lagi tersedia (terpakai, dipesan, kedaluwarsa, atau rusak)';
        elsif exists (select 1 from public.stock_ledger l join public.vouchers v on v.id = l.voucher_id
                      where v.account_id = a.id and l.reason <> 'restock') then
          v_reason := 'Ada riwayat stok selain restock (pemakaian, pembatalan, atau koreksi)';
        elsif exists (select 1 from public.approval_requests r where r.status = 'pending'
                      and r.target_id in (select id from public.vouchers where account_id = a.id)) then
          v_reason := 'Ada pengajuan koreksi stok yang menunggu keputusan';
        end if;
      end if;

      if v_reason is null then
        select count(*) into v_vouchers from public.vouchers where account_id = a.id;
        select coalesce(array_agg(code order by code), '{}') into v_restocks from public.restocks where account_id = a.id;
        perform set_config('app.deleting_account', a.id::text, true);
        delete from public.stock_ledger where account_id = a.id;
        delete from public.vouchers where account_id = a.id;
        delete from public.restocks where account_id = a.id;
        delete from public.accounts where id = a.id;
        perform set_config('app.deleting_account', '', true);
        v_deleted := v_deleted || jsonb_build_object('id', a.id, 'code', a.account_code, 'brand', a.brand_id, 'source', a.source,
                                                     'vouchers', v_vouchers, 'restocks', to_jsonb(v_restocks));
        v_results := v_results || jsonb_build_object('id', a.id, 'code', a.account_code, 'ok', true, 'vouchers', v_vouchers);
      else
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'code', a.account_code, 'reason', v_reason);
        v_results := v_results || jsonb_build_object('id', v_id, 'code', a.account_code, 'ok', false, 'reason', v_reason);
      end if;
    exception when others then  -- hanya akun ini yang dibatalkan (savepoint); akun lain tetap diproses
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'code', a.account_code, 'reason', 'Gagal: ' || sqlerrm);
      v_results := v_results || jsonb_build_object('id', v_id, 'code', a.account_code, 'ok', false, 'reason', 'Gagal: ' || sqlerrm);
    end;
  end loop;

  perform public.write_audit(case when jsonb_array_length(v_results) = 1 then 'account.delete' else 'account.bulk_delete' end,
    'accounts', case when jsonb_array_length(v_results) = 1 then v_results -> 0 ->> 'id' end, null,
    jsonb_build_object('deleted_count', jsonb_array_length(v_deleted), 'skipped_count', jsonb_array_length(v_skipped),
                       'deleted', v_deleted, 'skipped', v_skipped));
  return jsonb_build_object('deleted', jsonb_array_length(v_deleted), 'skipped', jsonb_array_length(v_skipped), 'results', v_results);
end $$;
revoke all on function public.delete_accounts(uuid[]) from public, anon, authenticated;
grant execute on function public.delete_accounts(uuid[]) to authenticated;
revoke all on function public.stock_ledger_guard() from public, anon, authenticated;
