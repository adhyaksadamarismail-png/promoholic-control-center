-- Fondasi: profil admin, peran, audit log, persetujuan, percobaan login.
-- Semua penulisan data operasional lewat fungsi SECURITY DEFINER (lihat migrasi functions),
-- jadi tabel di sini tidak punya kebijakan INSERT/UPDATE untuk staf.

create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum ('owner', 'staff');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,32}$'),
  full_name text not null check (length(trim(full_name)) > 0),
  role public.app_role not null default 'staff',
  can_restock_panel boolean not null default false,
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Peran dibaca dari database berdasarkan sesi (auth.uid()), tidak pernah dari input klien.
create or replace function public.current_app_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.is_active
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_app_role() = 'owner', false)
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.current_app_role() is not null
$$;

create or replace function public.require_active() returns public.app_role
language plpgsql stable security definer set search_path = '' as $$
declare r public.app_role := public.current_app_role();
begin
  if r is null then
    raise exception 'Akses ditolak: sesi tidak valid atau akun nonaktif' using errcode = '42501';
  end if;
  return r;
end $$;

create or replace function public.require_owner() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_owner() then
    raise exception 'Akses ditolak: khusus owner' using errcode = '42501';
  end if;
end $$;

-- Audit log: hanya bisa ditambah, tidak bisa diubah atau dihapus.
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id),
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index audit_log_entity_idx on public.audit_log (entity, entity_id);

create or replace function public.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Tabel % hanya boleh ditambah (append-only)', tg_table_name using errcode = '42501';
end $$;

create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function public.forbid_change();

create or replace function public.write_audit(p_action text, p_entity text, p_entity_id text, p_before jsonb, p_after jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_before, p_after)
$$;

create type public.approval_kind as enum ('order_cancel', 'stock_adjust', 'attendance_fix', 'benefit_fix');
create type public.approval_status as enum ('pending', 'approved', 'rejected');

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  kind public.approval_kind not null,
  target_id uuid not null,
  payload jsonb not null default '{}',
  reason text not null check (length(trim(reason)) >= 3),
  status public.approval_status not null default 'pending',
  requested_by uuid not null default auth.uid() references public.profiles (id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_note text
);
-- Satu pengajuan terbuka per objek dan jenis.
create unique index approval_one_pending on public.approval_requests (kind, target_id) where status = 'pending';

-- Dipakai route login di server (service role) untuk pembatasan percobaan.
create table public.login_attempts (
  id bigint generated always as identity primary key,
  username text not null,
  ip text,
  success boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_user_idx on public.login_attempts (username, at desc);
create index login_attempts_ip_idx on public.login_attempts (ip, at desc);

-- Format tampilan tersamar untuk nomor WA / nomor akun bagi staf.
create or replace function public.mask_tail(v text) returns text
language sql immutable set search_path = '' as $$
  select case when v is null then null
              when length(v) <= 8 then '••••'
              else left(v, 4) || '-••••-' || right(regexp_replace(v, '[^0-9]', '', 'g'), 4) end
$$;
