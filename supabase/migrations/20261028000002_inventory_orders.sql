-- Brand, harga modal berversi, konfigurasi voucher berversi, virtual device, akun, voucher,
-- restock, histori stok, dan transaksi order.
-- Aturan: nilai ketentuan yang belum diketahui disimpan NULL ("belum dikonfigurasi"), bukan angka perkiraan.

create type public.cost_basis as enum ('credit_per_account', 'rp_per_voucher', 'free');
create type public.account_source as enum ('vm', 'panel');
create type public.voucher_group as enum ('main', 'extra');
create type public.voucher_status as enum ('available', 'reserved', 'used', 'expired', 'broken');
create type public.restock_kind as enum ('new_account', 'add_stock');
create type public.order_status as enum ('draft', 'confirmed', 'cancelled');

create table public.brands (
  id text primary key check (id ~ '^[A-Z]{2}$'),          -- prefix ID akun, mis. KK, TM
  name text not null unique,
  reference_price integer check (reference_price >= 0),  -- harga acuan estimasi (Starbucks Grande), opsional
  vm_allowed boolean not null default false,             -- hanya brand yang dijalankan di virtual device
  created_at timestamptz not null default now()
);

create table public.credit_prices (
  id bigint generated always as identity primary key,
  rp_per_credit integer not null check (rp_per_credit > 0),
  effective_from timestamptz not null unique,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.brand_costs (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands (id),
  basis public.cost_basis not null,
  credits_per_account numeric(6, 3),
  rp_per_voucher integer,
  effective_from timestamptz not null,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (brand_id, effective_from),
  check ((basis = 'credit_per_account' and credits_per_account is not null and credits_per_account >= 0)
      or (basis = 'rp_per_voucher' and rp_per_voucher is not null and rp_per_voucher >= 0)
      or basis = 'free')
);

create table public.voucher_types (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null references public.brands (id),
  code text not null check (code ~ '^[A-Z0-9]{1,8}$'),   -- dipakai di ID voucher, mis. A, B, C, BP, D50, B1G1
  name text not null,
  grp public.voucher_group not null,
  -- Jumlah dibuat otomatis per akun baru. NULL = jumlah diisi saat restock.
  auto_per_account smallint check (auto_per_account between 0 and 10),
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (brand_id, code)
);

create table public.voucher_type_versions (
  id uuid primary key default gen_random_uuid(),
  voucher_type_id uuid not null references public.voucher_types (id),
  discount_pct numeric(5, 2) check (discount_pct > 0 and discount_pct <= 100),
  fixed_discount integer check (fixed_discount >= 0),
  min_purchase integer check (min_purchase >= 0),
  max_discount integer check (max_discount >= 0),
  b1g1_terms text,
  validity_note text,
  effective_from timestamptz not null,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (voucher_type_id, effective_from),
  check (discount_pct is null or fixed_discount is null)
);

create table public.cost_allocation_settings (
  id bigint generated always as identity primary key,
  method text not null check (method in ('equal_main', 'weighted_max_discount')),
  extra_gets_cost boolean not null default false,
  effective_from timestamptz not null unique,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.vm_devices (
  id text primary key check (id ~ '^VD-[0-9]{2,4}$'),
  name text not null unique,
  note text,
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null references public.brands (id),
  account_code text not null check (account_code ~ '^[A-Z]{2}-[0-9]{4}$'),
  source public.account_source not null,
  vm_device_id text references public.vm_devices (id),
  account_number text check (account_number ~ '^08[0-9]{8,11}$'),
  identity_note text,                          -- email/identitas, opsional
  entered_at timestamptz not null default now(),
  active_until date,
  needs_review boolean not null default false,
  review_note text,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (brand_id, account_code),
  check (left(account_code, 2) = brand_id),
  check ((source = 'vm' and vm_device_id is not null and account_number is not null)
      or (source = 'panel' and vm_device_id is null and account_number is null))
);
create unique index accounts_number_uq on public.accounts (account_number) where account_number is not null;

create sequence public.restock_seq;
create table public.restocks (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('RST-' || lpad(nextval('public.restock_seq')::text, 6, '0')),
  source public.account_source not null,
  kind public.restock_kind not null,
  account_id uuid not null references public.accounts (id),
  vm_device_id text references public.vm_devices (id),
  items jsonb not null,                        -- [{"type": "A", "qty": 1}, ...]
  account_cost_rp numeric(12, 2) not null default 0,  -- modal akun, dicatat sekali saat akun baru
  allocation_method text,
  idempotency_key uuid not null unique,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.vouchers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  account_id uuid not null references public.accounts (id),
  voucher_type_id uuid not null references public.voucher_types (id),
  grp public.voucher_group not null,
  slot smallint not null check (slot >= 1),
  status public.voucher_status not null default 'available',
  allocated_cost numeric(12, 2) not null default 0,
  restock_id uuid not null references public.restocks (id),
  created_at timestamptz not null default now(),
  -- Voucher utama otomatis tidak bisa dibuat dua kali: slot 1..n per jenis per akun unik.
  unique (account_id, voucher_type_id, slot)
);

create table public.stock_ledger (
  id bigint generated always as identity primary key,
  voucher_id uuid not null references public.vouchers (id),
  account_id uuid not null references public.accounts (id),
  delta smallint not null check (delta in (-1, 0, 1)),
  reason text not null check (reason in ('restock', 'reserve', 'release', 'use', 'reversal', 'expire', 'adjust')),
  status_after public.voucher_status not null,
  ref text,
  actor_id uuid default auth.uid() references public.profiles (id),
  at timestamptz not null default now()
);
create trigger stock_ledger_append_only before update or delete on public.stock_ledger
  for each row execute function public.forbid_change();

create table public.inventory_purchases (
  id bigint generated always as identity primary key,
  purchased_on date not null,
  credits numeric(10, 3),
  amount_rp integer not null check (amount_rp >= 0),
  note text,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.expenses (
  id bigint generated always as identity primary key,
  spent_on date not null,
  category text not null,
  amount_rp integer not null check (amount_rp >= 0),
  note text,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create sequence public.order_seq;
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  ref_order text,
  admin_id uuid not null default auth.uid() references public.profiles (id),
  account_id uuid not null references public.accounts (id),
  voucher_id uuid not null references public.vouchers (id),
  voucher_type_version_id uuid references public.voucher_type_versions (id),
  customer_name text not null check (length(trim(customer_name)) > 0),
  customer_wa text not null check (customer_wa ~ '^(\+62|62|0)8[0-9]{8,11}$'),
  menu_price integer not null check (menu_price > 0),
  discount integer not null check (discount >= 0),
  manual_discount boolean not null default false,
  price_after_discount integer not null check (price_after_discount >= 0),
  sell_price integer not null check (sell_price >= 0),
  extra_cost integer not null default 0 check (extra_cost >= 0),
  allocated_cost numeric(12, 2) not null default 0,
  hpp numeric(12, 2) not null,
  gross_profit numeric(12, 2) not null,
  net_profit numeric(12, 2) not null,
  rule_snapshot jsonb not null,
  credit_price_snapshot integer,
  needs_review boolean not null default false,
  review_reasons text[] not null default '{}',
  status public.order_status not null,
  idempotency_key uuid unique,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz
);
create index orders_admin_idx on public.orders (admin_id, created_at desc);
create index orders_confirmed_idx on public.orders (confirmed_at) where status = 'confirmed';

create table public.voucher_usages (
  id uuid primary key default gen_random_uuid(),
  voucher_id uuid not null references public.vouchers (id),
  order_id uuid not null references public.orders (id),
  customer_name text not null,
  customer_wa text not null,
  admin_id uuid not null references public.profiles (id),
  used_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversal_request_id uuid references public.approval_requests (id)
);
-- Satu voucher hanya boleh punya satu pemakaian aktif.
create unique index voucher_usages_one_active on public.voucher_usages (voucher_id) where reversed_at is null;
