-- Akun yang wajib ganti password (setelah reset owner) tidak bisa melakukan aksi apa pun lewat API
-- sampai password diganti. Sebelumnya ini hanya ditegakkan di halaman aplikasi.

create or replace function public.require_active() returns public.app_role
language plpgsql stable security definer set search_path = '' as $$
declare r public.app_role := public.current_app_role();
begin
  if r is null then
    raise exception 'Akses ditolak: sesi tidak valid atau akun nonaktif' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and must_change_password) then
    raise exception 'Akses ditolak: ganti password sementara terlebih dahulu' using errcode = '42501';
  end if;
  return r;
end $$;

-- Bukti bahwa password benar-benar diganti: hash password sementara disimpan di tabel tertutup saat reset/pembuatan
-- akun, lalu mark_password_changed hanya berhasil bila hash di auth.users sudah berbeda.
create table public.password_resets (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  temp_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.password_resets enable row level security;  -- tanpa policy: tidak terbaca klien mana pun
revoke all on public.password_resets from anon, authenticated;

create or replace function public._record_temp_password(p_profile uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.password_resets (profile_id, temp_hash)
  select id, encrypted_password from auth.users where id = p_profile
  on conflict (profile_id) do update set temp_hash = excluded.temp_hash, created_at = now()
$$;
revoke all on function public._record_temp_password(uuid) from public, anon, authenticated;
grant execute on function public._record_temp_password(uuid) to service_role;  -- dipanggil route server (buat akun staf)

create or replace function public.revoke_sessions(p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner();
  delete from auth.sessions where user_id = p_profile;
  update public.profiles set must_change_password = true where id = p_profile;
  perform public._record_temp_password(p_profile);
  perform public.write_audit('staff.reset_password', 'profiles', p_profile::text, null, null);
end $$;

-- Tidak memakai require_active() (yang kini menolak akun wajib-ganti-password).
create or replace function public.mark_password_changed() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.current_app_role() is null then
    raise exception 'Akses ditolak: sesi tidak valid atau akun nonaktif' using errcode = '42501';
  end if;
  if exists (select 1 from public.password_resets r join auth.users u on u.id = r.profile_id
             where r.profile_id = auth.uid() and u.encrypted_password = r.temp_hash) then
    raise exception 'Password belum diganti';
  end if;
  update public.profiles set must_change_password = false where id = auth.uid();
  delete from public.password_resets where profile_id = auth.uid();
end $$;
