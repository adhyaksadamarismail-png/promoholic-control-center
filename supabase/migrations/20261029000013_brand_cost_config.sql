-- Modal per brand diatur owner dari aplikasi (Keuangan → Modal per Brand), bukan SQL manual.
-- Satu fungsi: validasi di server, versi baru (histori tidak diubah), dan audit dalam satu transaksi.
-- Penulisan langsung ke tabel dicabut agar setiap perubahan pasti lewat validasi & audit ini.

create or replace function public.set_brand_cost(
  p_brand text, p_basis public.cost_basis, p_credits numeric, p_rp integer, p_effective_from date, p_note text default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_before public.brand_costs; v_id bigint; v_from timestamptz;
begin
  perform public.require_owner();
  if not exists (select 1 from public.brands where id = p_brand) then raise exception 'Brand tidak dikenal'; end if;
  if p_effective_from is null or p_effective_from < public.jkt_date(now()) then
    raise exception 'Tanggal mulai berlaku tidak boleh di masa lalu';
  end if;
  if p_basis = 'credit_per_account' then
    if p_credits is null or p_credits <= 0 or p_credits >= 1000 or p_rp is not null then
      raise exception 'Isi jumlah kredit per akun (lebih dari 0)';
    end if;
  elsif p_basis = 'rp_per_voucher' then
    if p_rp is null or p_rp <= 0 or p_credits is not null then
      raise exception 'Isi biaya per voucher dalam Rupiah (lebih dari 0)';
    end if;
  elsif p_credits is not null or p_rp is not null then  -- free
    raise exception 'Metode Gratis tidak memakai nilai kredit atau Rupiah';
  end if;

  v_from := (p_effective_from::timestamp) at time zone 'Asia/Jakarta';   -- 00:00 WIB
  select * into v_before from public.brand_costs where brand_id = p_brand and effective_from <= now()
  order by effective_from desc limit 1;
  begin
    insert into public.brand_costs (brand_id, basis, credits_per_account, rp_per_voucher, effective_from, created_by)
    values (p_brand, p_basis, p_credits, p_rp, v_from, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'Sudah ada modal brand ini dengan tanggal mulai berlaku yang sama' using errcode = '23505';
  end;

  perform public.write_audit('brand_cost.set', 'brand_costs', v_id::text,
    case when v_before.id is null then null else to_jsonb(v_before) end,
    jsonb_build_object('brand', p_brand, 'basis', p_basis, 'credits_per_account', p_credits, 'rp_per_voucher', p_rp,
                       'effective_from', v_from, 'note', nullif(trim(coalesce(p_note, '')), '')));
  return v_id;
end $$;

revoke all on function public.set_brand_cost(text, public.cost_basis, numeric, integer, date, text) from public, anon, authenticated;
grant execute on function public.set_brand_cost(text, public.cost_basis, numeric, integer, date, text) to authenticated;

-- Hanya lewat set_brand_cost (validasi + audit). Kebijakan baca tetap.
revoke insert on public.brand_costs from authenticated;
