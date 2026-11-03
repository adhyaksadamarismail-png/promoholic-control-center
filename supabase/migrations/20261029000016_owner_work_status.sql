-- Owner mengatur status kerja admin (Masuk / Istirahat / Off-Izin / Selesai) tanpa masuk ke akun admin.
-- Non-destruktif: status tetap berasal dari event absensi (append-only); owner menambah event baru dengan
-- pelaku (actor_id) dan alasan. Waktu Istirahat dan Off tidak dihitung sebagai jam kerja.

alter type public.attendance_kind add value if not exists 'off_start';
alter type public.attendance_kind add value if not exists 'off_end';

-- Event efektif terakhir (urut waktu lalu id, jadi dua event pada waktu sama tetap berurutan benar).
create or replace function public._attendance_last(p_shift uuid) returns table (kind text, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.kind::text, e.at from public.attendance_events e
  where e.shift_id = p_shift and not exists (select 1 from public.attendance_events c where c.corrects_id = e.id)
  order by e.at desc, e.id desc limit 1
$$;
revoke all on function public._attendance_last(uuid) from public, anon, authenticated;

-- Menit kerja bersih = kotor − istirahat − Off. break_minutes tetap hanya istirahat (batas istirahat wajar tidak
-- terpicu oleh izin).
create or replace function public.shift_minutes(p_shift uuid, p_now timestamptz default now())
returns table (net_minutes integer, break_minutes integer, gross_minutes integer)
language plpgsql stable security definer set search_path = '' as $$
declare r record; v_in timestamptz; v_out timestamptz; v_bs timestamptz; v_os timestamptz; v_break numeric := 0; v_off numeric := 0;
begin
  for r in select * from public.effective_attendance(p_shift) loop
    if r.kind = 'clock_in' then v_in := r.at;
    elsif r.kind = 'break_start' then v_bs := r.at;
    elsif r.kind = 'break_end' and v_bs is not null then v_break := v_break + extract(epoch from r.at - v_bs) / 60; v_bs := null;
    elsif r.kind::text = 'off_start' then v_os := r.at;
    elsif r.kind::text = 'off_end' and v_os is not null then v_off := v_off + extract(epoch from r.at - v_os) / 60; v_os := null;
    elsif r.kind = 'clock_out' then v_out := r.at;
    end if;
  end loop;
  if v_in is null then net_minutes := 0; break_minutes := 0; gross_minutes := 0; return next; return; end if;
  if v_bs is not null then v_break := v_break + extract(epoch from coalesce(v_out, p_now) - v_bs) / 60; end if;
  if v_os is not null then v_off := v_off + extract(epoch from coalesce(v_out, p_now) - v_os) / 60; end if;
  gross_minutes := floor(extract(epoch from coalesce(v_out, p_now) - v_in) / 60);
  break_minutes := floor(v_break);
  net_minutes := greatest(0, gross_minutes - floor(v_break)::integer - floor(v_off)::integer);
  return next;
end $$;

-- Absen mandiri admin: sama seperti sebelumnya, ditambah status Off (hanya owner yang bisa mengakhiri Off).
create or replace function public.attendance_action(p_shift uuid, p_kind public.attendance_kind) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; v_last text; v_allowed text[];
begin
  perform public.require_active();
  select * into s from public.shifts where id = p_shift for update;
  if not found or s.admin_id <> auth.uid() then raise exception 'Shift tidak ditemukan untuk akun ini' using errcode = '42501'; end if;
  if s.status in ('completed', 'cancelled', 'incomplete') then raise exception 'Shift sudah ditutup'; end if;

  select l.kind into v_last from public._attendance_last(p_shift) l;
  if v_last = 'off_start' then raise exception 'Status Off/Izin diatur owner; minta owner mengubah status Anda'; end if;
  v_allowed := case
    when v_last is null then array['clock_in']
    when v_last in ('clock_in', 'break_end', 'off_end') then array['break_start', 'clock_out']
    when v_last = 'break_start' then array['break_end']
    else array[]::text[] end;
  if not (p_kind::text = any (v_allowed)) then
    raise exception 'Urutan absen tidak valid: % tidak bisa dilakukan sekarang', p_kind;
  end if;
  if p_kind = 'clock_in' and (now() < s.planned_start - interval '2 hours' or now() > s.planned_end) then
    raise exception 'Absen masuk hanya bisa mulai 2 jam sebelum jadwal sampai akhir shift';
  end if;

  insert into public.attendance_events (shift_id, kind) values (p_shift, p_kind);
  if p_kind = 'clock_in' then update public.shifts set status = 'in_progress' where id = p_shift; end if;
  if p_kind = 'clock_out' then
    update public.shifts set status = 'completed' where id = p_shift;
    perform public._compute_earning(p_shift);
  end if;
  return now();
end $$;

-- Owner mengubah status kerja admin. Waktu default sekarang; boleh mundur untuk tindakan yang lupa dilakukan,
-- asal setelah event terakhir shift itu (koreksi lebih lama tetap lewat Koreksi). Alasan wajib; event mencatat
-- owner sebagai pelaku dan satu entri audit mencatat status sebelum/sesudah.
create or replace function public.owner_set_work_status(p_shift uuid, p_status text, p_at timestamptz, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; v_at timestamptz := coalesce(p_at, now()); v_last text; v_last_at timestamptz; v_cur text; v_reason text := trim(coalesce(p_reason, ''));
  v_kinds text[];
  k text;
begin
  perform public.require_owner();
  if p_status not in ('masuk', 'istirahat', 'off', 'selesai') then raise exception 'Status tidak valid'; end if;
  if length(v_reason) < 3 then raise exception 'Alasan perubahan status wajib diisi'; end if;
  select * into s from public.shifts where id = p_shift for update;
  if not found then raise exception 'Shift tidak ditemukan'; end if;
  if s.status in ('completed', 'cancelled') then raise exception 'Shift sudah ditutup; gunakan Koreksi untuk mengubah waktunya'; end if;
  if exists (select 1 from public.weekly_payrolls w where w.admin_id = s.admin_id and w.status <> 'open'
             and s.shift_date between w.period_start and w.period_end) then
    raise exception 'Rekap minggu ini sudah disetujui/dibayar; status tidak bisa diubah';
  end if;
  if v_at > now() + interval '1 minute' then raise exception 'Waktu tidak boleh di masa depan'; end if;
  if v_at < s.planned_start - interval '2 hours' then raise exception 'Waktu lebih awal dari jadwal shift'; end if;

  select l.kind, l.at into v_last, v_last_at from public._attendance_last(p_shift) l;
  if v_last_at is not null and v_at < v_last_at then
    raise exception 'Waktu harus setelah peristiwa terakhir (% WIB); gunakan Koreksi untuk waktu yang lebih awal',
      to_char(v_last_at at time zone 'Asia/Jakarta', 'DD/MM HH24:MI');
  end if;
  v_cur := case when v_last is null then 'belum'
                when v_last in ('clock_in', 'break_end', 'off_end') then 'masuk'
                when v_last = 'break_start' then 'istirahat'
                when v_last = 'off_start' then 'off'
                else 'selesai' end;
  if v_cur = p_status then raise exception 'Status admin sudah %', p_status; end if;
  if v_cur = 'selesai' then raise exception 'Shift sudah selesai; gunakan Koreksi'; end if;
  if v_cur = 'belum' and p_status <> 'masuk' then raise exception 'Admin belum masuk; ubah ke Masuk terlebih dahulu'; end if;

  -- Tutup status jeda yang sedang berjalan, lalu buka status baru (urutan id menjaga urutan pada waktu yang sama).
  v_kinds := case
    when p_status = 'masuk' then array[case v_cur when 'belum' then 'clock_in' when 'istirahat' then 'break_end' else 'off_end' end]
    else (case v_cur when 'istirahat' then array['break_end'] when 'off' then array['off_end'] else array[]::text[] end)
         || array[case p_status when 'istirahat' then 'break_start' when 'off' then 'off_start' else 'clock_out' end] end;
  foreach k in array v_kinds loop
    insert into public.attendance_events (shift_id, kind, at, correction_reason)
    values (p_shift, k::public.attendance_kind, v_at, v_reason);
  end loop;

  if p_status = 'masuk' and v_cur = 'belum' then update public.shifts set status = 'in_progress' where id = p_shift; end if;
  if p_status = 'selesai' then
    update public.shifts set status = 'completed' where id = p_shift;
    perform public._compute_earning(p_shift);  -- uang saku dihitung dengan aturan yang sama, menunggu persetujuan
  end if;

  perform public.write_audit('attendance.owner_status', 'shifts', s.id::text,
    jsonb_build_object('status', v_cur),
    jsonb_build_object('status', p_status, 'admin', s.admin_id, 'shift', s.code, 'at', v_at, 'reason', v_reason, 'events', to_jsonb(v_kinds)));
  return p_status;
end $$;
revoke all on function public.owner_set_work_status(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.owner_set_work_status(uuid, text, timestamptz, text) to authenticated;
