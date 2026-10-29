-- Data dummy KHUSUS pengembangan lokal (supabase db reset). Jangan dijalankan di produksi.
-- Akun uji: username owner, rani, dimas, sekar, bayu
-- Password uji (lokal saja): DevOnly-Promoholic-2026
-- Login memakai username; di Supabase Auth disimpan sebagai <username>@staff.promoholic.local

do $$
declare
  u record;
  v_owner uuid := '00000000-0000-4000-8000-000000000001';
  v_ids uuid[] := array[
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005']::uuid[];
  v_users text[] := array['owner', 'rani', 'dimas', 'sekar', 'bayu'];
  v_names text[] := array['Owner', 'Rani', 'Dimas', 'Sekar', 'Bayu'];
  i integer;
begin
  for i in 1 .. 5 loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new,
                            email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', v_ids[i], 'authenticated', 'authenticated',
            v_users[i] || '@staff.promoholic.local', extensions.crypt('DevOnly-Promoholic-2026', extensions.gen_salt('bf')),
            now(), '{"provider":"email","providers":["email"]}', jsonb_build_object('username', v_users[i]), now(), now(),
            '', '', '', '', '', '', '', '');  -- kolom token wajib string kosong, bukan NULL, agar Supabase Auth bisa membacanya
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_ids[i], v_ids[i]::text,
            jsonb_build_object('sub', v_ids[i]::text, 'email', v_users[i] || '@staff.promoholic.local'),
            'email', now(), now(), now());
    insert into public.profiles (id, username, full_name, role, can_restock_panel, must_change_password)
    values (v_ids[i], v_users[i], v_names[i],
            case when i = 1 then 'owner'::public.app_role else 'staff'::public.app_role end,
            v_users[i] in ('rani', 'sekar'), false);
  end loop;
end $$;

-- Konfigurasi awal (versi pertama, berlaku 1 Okt 2026).
insert into public.brands (id, name, reference_price, vm_allowed) values
  ('KK', 'Kopi Kenangan', null, true), ('TM', 'Tomoro Coffee', null, false), ('JJ', 'Janji Jiwa', null, false),
  ('FR', 'Fore Coffee', null, false), ('SB', 'Starbucks', 35000, false);

insert into public.credit_prices (rp_per_credit, effective_from, created_by)
values (4000, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001');

insert into public.brand_costs (brand_id, basis, credits_per_account, rp_per_voucher, effective_from, created_by) values
  ('KK', 'credit_per_account', 1, null, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001'),
  ('TM', 'credit_per_account', 0.3, null, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001'),
  ('JJ', 'credit_per_account', 0.4, null, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001'),
  ('FR', 'free', null, null, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001'),
  ('SB', 'rp_per_voucher', null, 1500, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001');

insert into public.voucher_types (brand_id, code, name, grp, auto_per_account, sort_order) values
  ('KK', 'A', 'Diskon 50% tanpa minimum', 'main', 1, 1),
  ('KK', 'B', 'Diskon 50% min. Rp50.000', 'main', 1, 2),
  ('KK', 'C', 'Diskon 50% min. Rp70.000', 'main', 1, 3),
  ('KK', 'BP', 'Baperan', 'extra', null, 4),
  ('TM', 'D50', 'Diskon 50%', 'main', 1, 1),
  ('TM', 'B1G1', 'Buy 1 Get 1', 'main', 1, 2),
  ('JJ', 'V', 'Voucher Janji Jiwa (belum dikonfigurasi)', 'main', null, 1),
  ('FR', 'D25', 'Diskon 25%', 'main', null, 1),
  ('SB', 'SB', 'Voucher Starbucks', 'main', null, 1);

-- NULL = belum dikonfigurasi. Janji Jiwa & Starbucks sengaja tanpa versi (potongan manual + ditinjau).
insert into public.voucher_type_versions (voucher_type_id, discount_pct, fixed_discount, min_purchase, max_discount, effective_from, created_by)
select vt.id, x.pct, x.fixed, x.min_p, x.max_d, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001'
from (values
  ('KK', 'A', 50.0, null::integer, 0, 35000),
  ('KK', 'B', 50.0, null, 50000, 30000),
  ('KK', 'C', 50.0, null, 70000, 30000),
  ('KK', 'BP', null, 8000, null, null),
  ('TM', 'D50', 50.0, null, null, null),
  ('TM', 'B1G1', null, null, null, null),
  ('FR', 'D25', 25.0, null, null, 50000)
) as x(brand, code, pct, fixed, min_p, max_d)
join public.voucher_types vt on vt.brand_id = x.brand and vt.code = x.code;

insert into public.cost_allocation_settings (method, extra_gets_cost, effective_from, created_by)
values ('equal_main', false, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001');

insert into public.allowance_rules (target_hours, amount_rp, cap_at_target, effective_from, created_by)
values (12, 50000, false, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001');

-- Tarif bonus CONTOH (dummy). Owner wajib menggantinya dengan versi baru sebelum dipakai sungguhan.
insert into public.bonus_rules (method, per_hour_rp, effective_from, created_by)
values ('per_net_hour', 4500, '2026-10-01 00:00+07', '00000000-0000-4000-8000-000000000001');

-- Jadwal reguler 4 hari/minggu per staf (ISO weekday: 1 = Senin).
insert into public.schedule_templates (admin_id, weekday, start_time, end_time, planned_break_minutes, effective_from, created_by)
select p.id, d, s.st, s.en, 60, '2026-10-01', '00000000-0000-4000-8000-000000000001'
from (values ('rani', array[1, 3, 5, 7], time '08:00', time '20:00'),
             ('dimas', array[2, 4, 6, 7], time '08:00', time '20:00'),
             ('sekar', array[1, 2, 4, 6], time '14:00', time '23:00'),
             ('bayu', array[3, 5, 6, 7], time '20:00', time '04:00')) as s(username, days, st, en)
join public.profiles p on p.username = s.username
cross join lateral unnest(s.days) as d;

-- Data operasional dibuat lewat fungsi yang sama dengan aplikasi (sebagai owner / staf).
do $$
declare
  v_week date := date_trunc('week', now() at time zone 'Asia/Jakarta')::date;
  v_voucher uuid;
  v_rani uuid := '00000000-0000-4000-8000-000000000002';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);

  perform public.vm_add_device('Device 1');
  perform public.vm_add_device('Device 2');
  perform public.vm_add_device('Device 3');
  perform public.vm_add_device('Device 4');

  perform public.vm_add_account('VD-01', 'KK-0142', '0857-7001-0103', null, '{"BP": 1}', gen_random_uuid());
  perform public.vm_add_account('VD-01', 'KK-0150', '0857-7001-0101', '2026-11-05', '{}', gen_random_uuid());
  perform public.vm_add_account('VD-01', 'KK-0151', '0857-7001-0102', '2026-11-05', '{"BP": 2}', gen_random_uuid());
  perform public.vm_add_account('VD-02', 'KK-0192', '0857-7002-0201', '2026-11-03', '{"BP": 2}', gen_random_uuid());
  perform public.vm_add_account('VD-02', 'KK-0201', '0857-7002-0202', '2026-11-09', '{"BP": 3}', gen_random_uuid());
  perform public.vm_add_account('VD-03', 'KK-0205', '0857-7003-0301', '2026-11-10', '{}', gen_random_uuid());

  perform public.panel_add_account('KK', 'KK-0187', null, '2026-10-29', '{}', gen_random_uuid());
  perform public.panel_add_account('KK', 'KK-0233', null, '2026-11-10', '{}', gen_random_uuid());
  perform public.panel_add_account('TM', 'TM-0044', null, '2026-10-30', '{}', gen_random_uuid());
  perform public.panel_add_account('JJ', 'JJ-0019', null, '2026-11-02', '{"V": 2}', gen_random_uuid());
  perform public.panel_add_account('FR', 'FR-0008', null, '2026-10-31', '{"D25": 3}', gen_random_uuid());
  perform public.panel_add_account('SB', 'SB-0011', null, '2026-11-15', '{"SB": 3}', gen_random_uuid());

  perform public.generate_regular_shifts(v_week);
  perform public.add_extra_shift(v_rani, (v_week + 1 + time '14:00') at time zone 'Asia/Jakarta',
                                 (v_week + 1 + time '20:00') at time zone 'Asia/Jakarta');

  -- Beberapa order contoh sebagai staf Rani.
  perform set_config('request.jwt.claims', json_build_object('sub', v_rani, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_rani::text, true);
  select id into v_voucher from public.vouchers where code = 'V-KK0192-A';
  perform public.record_order(v_voucher, 'Kevin Halim', '0813-9902-1180', 'KK-ORD-88120', 58000, 39000, 2000, null, null, true, gen_random_uuid());
  select id into v_voucher from public.vouchers where code = 'V-KK0192-B';
  perform public.record_order(v_voucher, 'Rizky Fauzan', '0857-2210-6612', 'KK-ORD-88177', 62000, 42000, 2000, null, null, true, gen_random_uuid());
  select id into v_voucher from public.vouchers where code = 'V-FR0008-D2501';
  perform public.record_order(v_voucher, 'Salsa Amelia', '0857-1122-3301', null, 64000, 52000, 0, null, null, true, gen_random_uuid());
  select id into v_voucher from public.vouchers where code = 'V-SB0011-SB01';
  perform public.record_order(v_voucher, 'Andi Wijaya', '0821-7788-0034', null, 58000, 45000, 0, 17400, null, false, gen_random_uuid());
end $$;
