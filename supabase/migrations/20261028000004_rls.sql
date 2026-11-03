-- Row Level Security. Prinsip:
-- * anon tidak bisa membaca apa pun.
-- * Staf membaca data operasional; data pribadi customer & nomor akun disamarkan lewat view.
-- * Penulisan data operasional hanya lewat fungsi (SECURITY DEFINER) yang mengecek peran.
-- * Tabel konfigurasi berversi hanya bisa ditambah owner; tidak ada UPDATE/DELETE histori.

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'audit_log', 'approval_requests', 'login_attempts',
    'brands', 'credit_prices', 'brand_costs', 'voucher_types', 'voucher_type_versions', 'cost_allocation_settings',
    'vm_devices', 'accounts', 'restocks', 'vouchers', 'stock_ledger', 'inventory_purchases', 'expenses',
    'orders', 'voucher_usages',
    'schedule_templates', 'shifts', 'attendance_events', 'allowance_rules', 'bonus_rules', 'shift_earnings',
    'weekly_payrolls', 'payouts', 'benefit_entitlements', 'benefit_claims'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- login_attempts: hanya service role (route login di server).
revoke select on public.login_attempts from authenticated;

-- Profil: staf melihat profil aktif (nama rekan), owner melihat semua.
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_owner() or (public.is_active_user() and is_active));

create policy audit_owner_read on public.audit_log for select to authenticated using (public.is_owner());

create policy approvals_read on public.approval_requests for select to authenticated
  using (public.is_owner() or requested_by = auth.uid());

-- Referensi & konfigurasi: dibaca semua pengguna aktif, ditambah owner (versi baru).
do $$
declare t text;
begin
  foreach t in array array['brands', 'credit_prices', 'brand_costs', 'voucher_types', 'voucher_type_versions',
                           'cost_allocation_settings', 'allowance_rules', 'bonus_rules'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_active_user())', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_owner())', t || '_owner_insert', t);
    execute format('grant insert on public.%I to authenticated', t);
  end loop;
end $$;
-- Jenis voucher boleh dinonaktifkan/diganti nama oleh owner; ketentuan angka tetap lewat versi.
create policy voucher_types_owner_update on public.voucher_types for update to authenticated
  using (public.is_owner()) with check (public.is_owner());
grant update (name, is_active, sort_order) on public.voucher_types to authenticated;

-- Virtual Machine: seluruhnya khusus owner, termasuk membaca daftar device.
create policy vm_devices_owner on public.vm_devices for select to authenticated using (public.is_owner());

-- Akun: tabel dasar (berisi nomor akun & identitas) hanya owner; staf lewat view account_list.
create policy accounts_owner_read on public.accounts for select to authenticated using (public.is_owner());

create policy restocks_read on public.restocks for select to authenticated
  using (public.is_owner() or (public.is_active_user() and source = 'panel'));
create policy vouchers_read on public.vouchers for select to authenticated using (public.is_active_user());
create policy ledger_read on public.stock_ledger for select to authenticated using (public.is_active_user());
create policy purchases_owner on public.inventory_purchases for select to authenticated using (public.is_owner());
create policy expenses_owner on public.expenses for select to authenticated using (public.is_owner());
create policy purchases_owner_insert on public.inventory_purchases for insert to authenticated with check (public.is_owner());
create policy expenses_owner_insert on public.expenses for insert to authenticated with check (public.is_owner());
grant insert on public.inventory_purchases, public.expenses to authenticated;

-- Order & pemakaian: owner semua, staf hanya order yang ia catat sendiri (data lain lewat view tersamar).
create policy orders_read on public.orders for select to authenticated
  using (public.is_owner() or (public.is_active_user() and admin_id = auth.uid()));
create policy usages_read on public.voucher_usages for select to authenticated
  using (public.is_owner() or (public.is_active_user() and admin_id = auth.uid()));

-- Absensi & keuangan admin: owner semua, staf hanya miliknya.
create policy schedules_read on public.schedule_templates for select to authenticated
  using (public.is_owner() or admin_id = auth.uid());
create policy schedules_owner_insert on public.schedule_templates for insert to authenticated with check (public.is_owner());
grant insert on public.schedule_templates to authenticated;

create policy shifts_read on public.shifts for select to authenticated
  using (public.is_owner() or (public.is_active_user() and admin_id = auth.uid()));
create policy attendance_read on public.attendance_events for select to authenticated
  using (public.is_owner() or exists (select 1 from public.shifts s where s.id = shift_id and s.admin_id = auth.uid()));
create policy earnings_read on public.shift_earnings for select to authenticated
  using (public.is_owner() or admin_id = auth.uid());
create policy payrolls_read on public.weekly_payrolls for select to authenticated
  using (public.is_owner() or admin_id = auth.uid());
create policy payouts_read on public.payouts for select to authenticated
  using (public.is_owner() or exists (select 1 from public.weekly_payrolls w where w.id = payroll_id and w.admin_id = auth.uid()));
create policy entitlements_read on public.benefit_entitlements for select to authenticated
  using (public.is_owner() or admin_id = auth.uid());
create policy claims_read on public.benefit_claims for select to authenticated
  using (public.is_owner() or admin_id = auth.uid());

-- View untuk semua pengguna aktif dengan penyamaran untuk staf.
-- View berjalan dengan hak pemiliknya (melewati RLS tabel dasar), jadi filter peran ditulis eksplisit.
create view public.account_list with (security_barrier = true) as
select a.id, a.brand_id, a.account_code, a.source,
       case when public.is_owner() then a.vm_device_id end as vm_device_id,
       case when public.is_owner() then a.account_number else public.mask_tail(a.account_number) end as account_number,
       case when public.is_owner() then a.identity_note end as identity_note,
       a.entered_at, a.active_until, a.needs_review, a.review_note
from public.accounts a
where public.is_active_user();

create view public.voucher_usage_list with (security_barrier = true) as
select u.id, u.voucher_id, u.order_id, u.customer_name,
       case when public.is_owner() or u.admin_id = auth.uid() then u.customer_wa else public.mask_tail(u.customer_wa) end as customer_wa,
       u.admin_id, p.full_name as admin_name, o.code as order_code, u.used_at, u.reversed_at
from public.voucher_usages u
join public.orders o on o.id = u.order_id
join public.profiles p on p.id = u.admin_id
where public.is_active_user();

revoke all on public.account_list, public.voucher_usage_list from anon;
grant select on public.account_list, public.voucher_usage_list to authenticated;
