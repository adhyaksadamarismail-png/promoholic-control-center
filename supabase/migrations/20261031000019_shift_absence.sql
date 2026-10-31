-- Ketidakhadiran admin (non-destruktif): owner menandai shift yang belum dimulai sebagai Tidak Masuk, Izin, atau Sakit.
-- Shift tetap tersimpan sebagai riwayat, tidak ada jam kerja, uang saku, atau benefit. Berbeda dari Off/Izin yang
-- dipakai saat shift berjalan. Setiap perubahan dicatat append-only (shift_absence_log) dan di audit log.

-- 1. Status & kolom ---------------------------------------------------------
alter type public.shift_status add value if not exists 'absent';

alter table public.shifts add column absence_kind text check (absence_kind in ('tidak_masuk', 'izin', 'sakit'));
-- Status 'absent' dan jenisnya selalu berpasangan. Dibandingkan sebagai teks karena nilai enum baru belum bisa dipakai di transaksi ini.
alter table public.shifts add constraint shifts_absence_pair check ((status::text = 'absent') = (absence_kind is not null));

create table public.shift_absence_log (
  id bigint generated always as identity primary key,
  shift_id uuid not null references public.shifts (id),
  admin_id uuid not null references public.profiles (id),
  kind text check (kind in ('tidak_masuk', 'izin', 'sakit')),  -- NULL = status dihapus
  previous_kind text,
  previous_status text not null,
  note text check (length(note) <= 500),
  reason text check (length(reason) <= 500),                   -- wajib untuk koreksi, diperiksa di fungsi
  attachment_path text,
  actor_id uuid not null default auth.uid() references public.profiles (id),
  at timestamptz not null default now()
);
create index shift_absence_log_shift_idx on public.shift_absence_log (shift_id, id);
create trigger shift_absence_log_append_only before update or delete on public.shift_absence_log
  for each row execute function public.forbid_change();

alter table public.shift_absence_log enable row level security;
revoke all on public.shift_absence_log from anon;
revoke insert, update, delete, truncate on public.shift_absence_log from authenticated;
grant select on public.shift_absence_log to authenticated;
-- Catatan & lampiran khusus owner; admin hanya melihat statusnya di shifts.absence_kind.
create policy shift_absence_log_read on public.shift_absence_log for select to authenticated using (public.is_owner());

-- 2. Bukti surat: storage privat khusus owner -------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('absence-proofs', 'absence-proofs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Path: <shift_id>/<file>. Tidak ada policy update/delete: bukti tidak bisa diganti setelah diunggah (pembersihan oleh server).
create policy absence_proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'absence-proofs' and public.is_owner());
create policy absence_proofs_read on storage.objects for select to authenticated
  using (bucket_id = 'absence-proofs' and public.is_owner());

-- 3. Shift yang ditandai tidak hadir tidak bisa diabsen ----------------------
-- Satu penjaga untuk semua jalur: absen admin, status owner, koreksi, dan persetujuan koreksi.
create or replace function public.attendance_absent_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.shifts s where s.id = new.shift_id and s.status::text = 'absent') then
    raise exception 'Shift ini tercatat tidak hadir. Hapus status ketidakhadiran dulu sebelum mencatat absensi';
  end if;
  return new;
end $$;
create trigger attendance_absent_guard before insert on public.attendance_events
  for each row execute function public.attendance_absent_guard();

-- 4. Menetapkan, mengoreksi, atau menghapus status ---------------------------
-- p_kind NULL = hapus status. Koreksi & penghapusan wajib beralasan. Lampiran lama tetap berlaku bila tidak diganti.
create or replace function public.set_shift_absence(
  p_shift uuid, p_kind text, p_note text, p_attachment text, p_reason text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s public.shifts; v_note text := nullif(trim(coalesce(p_note, '')), ''); v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_attachment text := nullif(trim(coalesce(p_attachment, '')), ''); v_last public.shift_absence_log; v_status text; v_prev text;
begin
  perform public.require_owner();
  if p_kind is not null and p_kind not in ('tidak_masuk', 'izin', 'sakit') then raise exception 'Pilih status: Tidak Masuk, Izin, atau Sakit'; end if;
  select * into s from public.shifts where id = p_shift for update;
  if not found then raise exception 'Shift tidak ditemukan'; end if;
  if s.status::text in ('completed', 'cancelled') then raise exception 'Shift sudah ditutup atau dibatalkan'; end if;
  if s.status::text = 'in_progress' or exists (select 1 from public.effective_attendance(p_shift)) then
    raise exception 'Shift sudah dimulai: gunakan Off / Izin atau Koreksi';
  end if;
  if exists (select 1 from public.weekly_payrolls w where w.admin_id = s.admin_id
             and s.shift_date between w.period_start and w.period_end and w.status::text <> 'open') then
    raise exception 'Rekap minggu ini sudah terkunci; gunakan koreksi di periode berikutnya';
  end if;
  if length(v_note) > 500 or length(v_reason) > 500 then raise exception 'Catatan maksimal 500 karakter'; end if;
  if v_attachment is not null and ((storage.foldername(v_attachment))[1] <> p_shift::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'absence-proofs' and o.name = v_attachment)) then
    raise exception 'Lampiran tidak ditemukan. Unggah ulang';
  end if;

  select * into v_last from public.shift_absence_log where shift_id = p_shift order by id desc limit 1;

  if s.absence_kind is null then
    if p_kind is null then raise exception 'Shift ini tidak punya status ketidakhadiran'; end if;
    v_status := s.status::text;
  else
    if coalesce(length(v_reason), 0) < 3 then raise exception 'Tulis alasan koreksi'; end if;
    v_status := v_last.previous_status;  -- status asli sebelum ditandai, dipakai saat status dihapus
    if p_kind is not distinct from s.absence_kind and v_attachment is null and v_note is not distinct from v_last.note then
      raise exception 'Tidak ada perubahan';
    end if;
    if p_kind is null then
      v_attachment := null;
    else
      v_attachment := coalesce(v_attachment, v_last.attachment_path);
    end if;
  end if;
  v_prev := s.absence_kind;

  insert into public.shift_absence_log (shift_id, admin_id, kind, previous_kind, previous_status, note, reason, attachment_path)
  values (p_shift, s.admin_id, p_kind, v_prev, v_status, v_note, v_reason, v_attachment);

  if p_kind is null then
    update public.shifts set status = v_status::public.shift_status, absence_kind = null where id = p_shift;
  else
    update public.shifts set status = 'absent'::text::public.shift_status, absence_kind = p_kind where id = p_shift;
  end if;

  -- Audit tanpa isi catatan (bisa berisi data kesehatan); isi lengkap ada di shift_absence_log khusus owner.
  perform public.write_audit('attendance.absence', 'shifts', p_shift::text, jsonb_build_object('kind', v_prev),
    jsonb_build_object('kind', p_kind, 'shift', s.code, 'admin', s.admin_id, 'date', s.shift_date,
      'attachment', v_attachment is not null, 'reason', v_reason));
  return s.code;
end $$;

-- Hak eksekusi -------------------------------------------------------------
revoke all on function public.attendance_absent_guard() from public, anon, authenticated;
revoke all on function public.set_shift_absence(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_shift_absence(uuid, text, text, text, text) to authenticated;
