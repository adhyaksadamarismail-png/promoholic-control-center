-- Arsip akun (soft delete). Hanya menandai akun; order, pemakaian voucher, voucher, restock, dan riwayat stok
-- tidak disentuh, sehingga laporan keuangan lama dan relasi historis tetap utuh. Akun bisa dipulihkan.

alter table public.accounts
  add column archived_at timestamptz,
  add column archived_by uuid references public.profiles (id),
  add column archive_note text;
create index accounts_archived_idx on public.accounts (archived_at) where archived_at is not null;

-- View tetap memuat akun arsip: riwayat voucher & batch perlu ID akunnya. Daftar operasional memfilter archived_at.
create or replace view public.account_list with (security_barrier = true) as
select a.id, a.brand_id, a.account_code, a.source,
       case when public.is_owner() then a.vm_device_id end as vm_device_id,
       case when public.is_owner() or a.inventory = 'baperan' then a.account_number else public.mask_tail(a.account_number) end as account_number,
       case when public.is_owner() then a.identity_note end as identity_note,
       a.entered_at, a.active_until, a.needs_review, a.review_note,
       a.inventory,
       case when public.is_owner() then a.pin end as pin,
       a.archived_at,
       case when public.is_owner() then a.archive_note end as archive_note
from public.accounts a
where public.is_active_user();

-- Akun arsip tidak bisa dipakai untuk order atau voucher baru, lewat jalur apa pun (form, bulk, API).
create or replace function public.account_not_archived() returns trigger
language plpgsql set search_path = '' as $$
declare v_code text;
begin
  if new.account_id is null then return new; end if;
  select account_code into v_code from public.accounts where id = new.account_id and archived_at is not null;
  if found then
    raise exception 'Akun % sudah diarsipkan. Pulihkan dulu dari tab Diarsipkan sebelum dipakai.', v_code;
  end if;
  return new;
end $$;
create trigger orders_account_not_archived before insert on public.orders
  for each row execute function public.account_not_archived();
create trigger vouchers_account_not_archived before insert on public.vouchers
  for each row execute function public.account_not_archived();

-- ID akun arsip tetap terpakai (unik per brand); arahkan ke pemulihan, bukan akun ganda.
create or replace function public._check_account_code(p_brand text, p_code text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_key text; v_existing text; v_archived timestamptz;
begin
  if p_code !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' or length(p_code) not between 3 and 32 then
    raise exception 'ID akun "%" tidak valid: gunakan 3–32 huruf/angka, tanda hubung hanya di tengah (mis. 195678 atau KK-195678)', p_code;
  end if;
  v_key := regexp_replace(p_code, '^' || p_brand || '-', '');
  select account_code, archived_at into v_existing, v_archived from public.accounts where brand_id = p_brand and account_key = v_key;
  if found and v_archived is not null then
    raise exception 'ID akun % sudah ada di arsip (tercatat sebagai %). Pulihkan dari Daftar Akun → Diarsipkan.', p_code, v_existing
      using errcode = '23505';
  elsif found then
    raise exception 'ID akun % sudah terdaftar di brand ini (tercatat sebagai %). Gunakan "Tambah voucher ke akun yang ada".', p_code, v_existing
      using errcode = '23505';
  end if;
  return v_key;
end $$;
revoke all on function public._check_account_code(text, text) from public, anon, authenticated;

-- Arsipkan banyak akun. Per akun dalam savepoint sendiri; satu entri audit per operasi.
create or replace function public.archive_accounts(p_accounts uuid[], p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; a public.accounts; v_reason text; v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_results jsonb := '[]'; v_done jsonb := '[]'; v_skipped jsonb := '[]';
begin
  perform public.require_owner();
  if coalesce(cardinality(p_accounts), 0) = 0 then raise exception 'Pilih minimal satu akun'; end if;
  if cardinality(p_accounts) > 200 then raise exception 'Maksimal 200 akun per operasi'; end if;

  foreach v_id in array (select array_agg(distinct x) from unnest(p_accounts) x) loop
    v_reason := null;
    begin
      select * into a from public.accounts where id = v_id for update;
      if not found then
        v_reason := 'Akun tidak ditemukan';
      elsif a.archived_at is not null then
        v_reason := 'Akun sudah diarsipkan';
      else
        perform 1 from public.vouchers where account_id = a.id for update;  -- tunggu order yang sedang berjalan
        if exists (select 1 from public.vouchers where account_id = a.id and status = 'reserved') then
          v_reason := 'Ada voucher yang dipesan draft order; konfirmasi atau batalkan draft dulu';
        end if;
      end if;

      if v_reason is null then
        update public.accounts set archived_at = now(), archived_by = auth.uid(), archive_note = v_note where id = a.id;
        v_done := v_done || jsonb_build_object('id', a.id, 'code', a.account_code, 'brand', a.brand_id, 'source', a.source);
        v_results := v_results || jsonb_build_object('id', a.id, 'code', a.account_code, 'ok', true);
      else
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'code', a.account_code, 'reason', v_reason);
        v_results := v_results || jsonb_build_object('id', v_id, 'code', a.account_code, 'ok', false, 'reason', v_reason);
      end if;
    exception when others then  -- hanya akun ini yang gagal; akun lain tetap diproses
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'code', a.account_code, 'reason', 'Gagal: ' || sqlerrm);
      v_results := v_results || jsonb_build_object('id', v_id, 'code', a.account_code, 'ok', false, 'reason', 'Gagal: ' || sqlerrm);
    end;
  end loop;

  perform public.write_audit('account.archive', 'accounts', case when jsonb_array_length(v_results) = 1 then v_results -> 0 ->> 'id' end, null,
    jsonb_build_object('done_count', jsonb_array_length(v_done), 'skipped_count', jsonb_array_length(v_skipped),
                       'note', v_note, 'done', v_done, 'skipped', v_skipped));
  return jsonb_build_object('done', jsonb_array_length(v_done), 'skipped', jsonb_array_length(v_skipped), 'results', v_results);
end $$;

-- Pulihkan akun: hanya mengembalikan penanda arsip; voucher, status, dan histori tidak berubah.
create or replace function public.restore_accounts(p_accounts uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; a public.accounts; v_results jsonb := '[]'; v_done jsonb := '[]'; v_skipped jsonb := '[]';
begin
  perform public.require_owner();
  if coalesce(cardinality(p_accounts), 0) = 0 then raise exception 'Pilih minimal satu akun'; end if;
  if cardinality(p_accounts) > 200 then raise exception 'Maksimal 200 akun per operasi'; end if;

  foreach v_id in array (select array_agg(distinct x) from unnest(p_accounts) x) loop
    select * into a from public.accounts where id = v_id for update;
    if not found or a.archived_at is null then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'code', a.account_code, 'reason', 'Akun tidak ada di arsip');
      v_results := v_results || jsonb_build_object('id', v_id, 'code', a.account_code, 'ok', false, 'reason', 'Akun tidak ada di arsip');
    else
      update public.accounts set archived_at = null, archived_by = null, archive_note = null where id = a.id;
      v_done := v_done || jsonb_build_object('id', a.id, 'code', a.account_code, 'archived_at', a.archived_at, 'note', a.archive_note);
      v_results := v_results || jsonb_build_object('id', a.id, 'code', a.account_code, 'ok', true);
    end if;
  end loop;

  perform public.write_audit('account.restore', 'accounts', case when jsonb_array_length(v_results) = 1 then v_results -> 0 ->> 'id' end, null,
    jsonb_build_object('done_count', jsonb_array_length(v_done), 'skipped_count', jsonb_array_length(v_skipped), 'done', v_done, 'skipped', v_skipped));
  return jsonb_build_object('done', jsonb_array_length(v_done), 'skipped', jsonb_array_length(v_skipped), 'results', v_results);
end $$;

revoke all on function public.archive_accounts(uuid[], text), public.restore_accounts(uuid[]), public.account_not_archived() from public, anon, authenticated;
grant execute on function public.archive_accounts(uuid[], text), public.restore_accounts(uuid[]) to authenticated;

-- Penghapusan permanen tidak lagi dipakai aplikasi: arsip menggantikannya.
revoke execute on function public.delete_accounts(uuid[]) from authenticated;
