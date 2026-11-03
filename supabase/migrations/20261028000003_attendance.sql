-- Jadwal, shift reguler/tambahan, absensi, aturan uang saku & bonus berversi,
-- earning per shift, payroll mingguan, pencairan, serta hak & klaim benefit KopKen.
-- Zona waktu operasional: Asia/Jakarta.

create type public.shift_kind as enum ('regular', 'extra');
create type public.shift_status as enum ('scheduled', 'in_progress', 'completed', 'incomplete', 'cancelled');
create type public.attendance_kind as enum ('clock_in', 'break_start', 'break_end', 'clock_out');
create type public.earning_status as enum ('pending', 'approved', 'rejected');
create type public.payroll_status as enum ('open', 'approved', 'paid');

-- Jadwal reguler per admin; perubahan = baris baru dengan effective_from (histori tetap ada).
create table public.schedule_templates (
  id bigint generated always as identity primary key,
  admin_id uuid not null references public.profiles (id),
  weekday smallint not null check (weekday between 1 and 7),  -- ISO: 1 = Senin
  start_time time not null,
  end_time time not null,                                     -- boleh < start_time (lewat tengah malam)
  planned_break_minutes smallint not null default 60 check (planned_break_minutes >= 0),
  effective_from date not null,
  effective_to date,
  change_note text,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create sequence public.shift_seq;
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  admin_id uuid not null references public.profiles (id),
  kind public.shift_kind not null,
  shift_date date not null,
  planned_start timestamptz not null,
  planned_end timestamptz not null,
  status public.shift_status not null default 'scheduled',
  needs_review boolean not null default false,
  review_reasons text[] not null default '{}',
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (admin_id, planned_start),
  check (planned_end > planned_start and planned_end - planned_start <= interval '20 hours')
);

create table public.attendance_events (
  id bigint generated always as identity primary key,
  shift_id uuid not null references public.shifts (id),
  kind public.attendance_kind not null,
  at timestamptz not null default now(),         -- selalu waktu server
  actor_id uuid not null default auth.uid() references public.profiles (id),
  corrects_id bigint references public.attendance_events (id),  -- diisi untuk koreksi owner
  correction_reason text,
  check (corrects_id is null or correction_reason is not null)
);
create unique index attendance_one_clock_in on public.attendance_events (shift_id)
  where kind = 'clock_in' and corrects_id is null;
create unique index attendance_one_clock_out on public.attendance_events (shift_id)
  where kind = 'clock_out' and corrects_id is null;
create trigger attendance_append_only before update or delete on public.attendance_events
  for each row execute function public.forbid_change();

create table public.allowance_rules (
  id bigint generated always as identity primary key,
  target_hours numeric(4, 2) not null check (target_hours > 0),
  amount_rp integer not null check (amount_rp >= 0),
  cap_at_target boolean not null default false,
  suspicious_break_minutes smallint not null default 120,
  suspicious_shift_hours numeric(4, 2) not null default 14,
  effective_from timestamptz not null unique,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.bonus_rules (
  id bigint generated always as identity primary key,
  method text not null check (method in ('fixed_per_shift', 'per_net_hour', 'per_shift_type')),
  fixed_rp integer check (fixed_rp >= 0),
  per_hour_rp integer check (per_hour_rp >= 0),
  day_per_hour_rp integer check (day_per_hour_rp >= 0),
  night_per_hour_rp integer check (night_per_hour_rp >= 0),
  night_starts time not null default '22:00',
  effective_from timestamptz not null unique,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  check ((method = 'fixed_per_shift' and fixed_rp is not null)
      or (method = 'per_net_hour' and per_hour_rp is not null)
      or (method = 'per_shift_type' and day_per_hour_rp is not null and night_per_hour_rp is not null))
);

create table public.shift_earnings (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null unique references public.shifts (id),
  admin_id uuid not null references public.profiles (id),
  kind public.shift_kind not null,
  net_minutes integer not null check (net_minutes >= 0),
  base_allowance numeric(12, 2) not null default 0,   -- hanya shift reguler
  bonus numeric(12, 2) not null default 0,            -- hanya shift tambahan
  allowance_rule_id bigint references public.allowance_rules (id),
  bonus_rule_id bigint references public.bonus_rules (id),
  status public.earning_status not null default 'pending',
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_note text,
  computed_at timestamptz not null default now(),
  check ((kind = 'regular' and bonus = 0) or (kind = 'extra' and base_allowance = 0))
);

create table public.weekly_payrolls (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles (id),
  period_start date not null check (extract(isodow from period_start) = 1),
  period_end date generated always as (period_start + 6) stored,
  regular_scheduled integer not null default 0,
  regular_completed integer not null default 0,
  net_minutes integer not null default 0,
  base_total numeric(12, 2) not null default 0,
  adjustments jsonb not null default '[]',             -- [{"amount": -4167, "reason": "..."}]
  adjustment_total numeric(12, 2) not null default 0,
  bonus_total numeric(12, 2) not null default 0,
  approved_total numeric(12, 2),
  status public.payroll_status not null default 'open',
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (admin_id, period_start)
);

create sequence public.payout_seq;
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  payroll_id uuid not null unique references public.weekly_payrolls (id),  -- satu periode = satu pencairan
  amount numeric(12, 2) not null check (amount >= 0),
  paid_at timestamptz not null default now(),
  paid_by uuid not null default auth.uid() references public.profiles (id),
  note text
);

-- Hak benefit: otomatis satu per shift terjadwal (reguler maupun tambahan).
create table public.benefit_entitlements (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null unique references public.shifts (id),
  admin_id uuid not null references public.profiles (id),
  cups smallint not null default 1 check (cups = 1),
  created_at timestamptz not null default now()
);

-- Klaim: terpisah dari hak; satu klaim per hak, dikunci di database.
create table public.benefit_claims (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.benefit_entitlements (id),
  admin_id uuid not null default auth.uid() references public.profiles (id),
  claimed_at timestamptz not null default now(),
  voided_at timestamptz,
  void_request_id uuid references public.approval_requests (id)
);
create unique index benefit_one_active_claim on public.benefit_claims (entitlement_id) where voided_at is null;

create or replace function public.create_entitlement_for_shift() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.benefit_entitlements (shift_id, admin_id) values (new.id, new.admin_id);
  return new;
end $$;

create trigger shifts_entitlement after insert on public.shifts
  for each row execute function public.create_entitlement_for_shift();
