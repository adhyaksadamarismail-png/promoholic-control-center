-- Perubahan jadwal reguler berversi (versi lama ditutup, tidak dihapus) dan penanda ganti password.

create or replace function public.set_schedule(p_admin uuid, p_weekdays integer[], p_start time, p_end time,
                                               p_break integer, p_effective_from date, p_note text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_before jsonb; v_n integer;
begin
  perform public.require_owner();
  if not exists (select 1 from public.profiles where id = p_admin and role = 'staff') then raise exception 'Staf tidak ditemukan'; end if;
  if coalesce(cardinality(p_weekdays), 0) = 0 then raise exception 'Pilih minimal satu hari kerja'; end if;
  if exists (select 1 from unnest(p_weekdays) d where d not between 1 and 7) then raise exception 'Hari tidak valid'; end if;
  if p_effective_from < public.jkt_date(now()) then raise exception 'Tanggal berlaku tidak boleh di masa lalu'; end if;
  if coalesce(length(trim(p_note)), 0) < 3 then raise exception 'Alasan perubahan wajib diisi'; end if;
  if p_start = p_end then raise exception 'Jam mulai dan selesai tidak boleh sama'; end if;
  if exists (select 1 from public.schedule_templates where admin_id = p_admin and effective_from >= p_effective_from) then
    raise exception 'Sudah ada perubahan jadwal yang berlaku pada atau setelah tanggal ini';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]') into v_before from public.schedule_templates t
  where admin_id = p_admin and (effective_to is null or effective_to >= p_effective_from);
  update public.schedule_templates set effective_to = p_effective_from - 1
  where admin_id = p_admin and (effective_to is null or effective_to >= p_effective_from);

  insert into public.schedule_templates (admin_id, weekday, start_time, end_time, planned_break_minutes, effective_from, change_note)
  select p_admin, d, p_start, p_end, coalesce(p_break, 60), p_effective_from, trim(p_note)
  from (select distinct unnest(p_weekdays) d) x;
  get diagnostics v_n = row_count;

  perform public.write_audit('schedule.set', 'schedule_templates', p_admin::text, v_before,
    jsonb_build_object('weekdays', p_weekdays, 'start', p_start, 'end', p_end, 'from', p_effective_from, 'note', p_note));
  return v_n;
end $$;

-- Dipanggil route server tepat setelah password pengguna berhasil diganti.
create or replace function public.mark_password_changed() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_active();
  update public.profiles set must_change_password = false where id = auth.uid();
end $$;

revoke all on function public.set_schedule(uuid, integer[], time, time, integer, date, text) from public, anon, authenticated;
revoke all on function public.mark_password_changed() from public, anon, authenticated;
grant execute on function public.set_schedule(uuid, integer[], time, time, integer, date, text), public.mark_password_changed()
  to authenticated;
