-- Fungsi server untuk jadwal, absensi, earning, payroll mingguan, benefit, persetujuan, dan akun staf.

create sequence if not exists public.shift_code_seq;

create or replace function public._shift_code(p_kind public.shift_kind, p_admin uuid, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare v_user text; v_base text; v_n integer;
begin
  select username into v_user from public.profiles where id = p_admin;
  v_base := case when p_kind = 'regular' then 'REG-' else 'EXT-' end || to_char(p_date, 'YYMMDD') || '-' || v_user;
  select count(*) into v_n from public.shifts where code = v_base or code like v_base || '-%';
  return case when v_n = 0 then v_base else v_base || '-' || (v_n + 1) end;
end $$;

-- Owner membuat shift reguler satu minggu dari jadwal yang berlaku.
create or replace function public.generate_regular_shifts(p_week_start date) returns integer
language plpgsql security definer set search_path = '' as $$
declare t record; v_date date; v_start timestamptz; v_end timestamptz; v_count integer := 0;
begin
  perform public.require_owner();
  if extract(isodow from p_week_start) <> 1 then raise exception 'Periode harus dimulai hari Senin'; end if;
  for t in
    select st.*, p.is_active from public.schedule_templates st join public.profiles p on p.id = st.admin_id
    where p.is_active and st.effective_from <= p_week_start + 6 and (st.effective_to is null or st.effective_to >= p_week_start)
  loop
    v_date := p_week_start + (t.weekday - 1);
    continue when v_date < t.effective_from or (t.effective_to is not null and v_date > t.effective_to);
    v_start := (v_date + t.start_time) at time zone 'Asia/Jakarta';
    v_end := (v_date + t.end_time + case when t.end_time <= t.start_time then interval '1 day' else interval '0' end) at time zone 'Asia/Jakarta';
    insert into public.shifts (code, admin_id, kind, shift_date, planned_start, planned_end)
    values (public._shift_code('regular', t.admin_id, v_date), t.admin_id, 'regular', v_date, v_start, v_end)
    on conflict (admin_id, planned_start) do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  perform public.write_audit('shift.generate_week', 'shifts', p_week_start::text, null, jsonb_build_object('created', v_count));
  return v_count;
end $$;

create or replace function public.add_extra_shift(p_admin uuid, p_start timestamptz, p_end timestamptz) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_date date := public.jkt_date(p_start);
begin
  perform public.require_owner();
  v_code := public._shift_code('extra', p_admin, v_date);
  insert into public.shifts (code, admin_id, kind, shift_date, planned_start, planned_end)
  values (v_code, p_admin, 'extra', v_date, p_start, p_end);
  perform public.write_audit('shift.add_extra', 'shifts', v_code, null, jsonb_build_object('start', p_start, 'end', p_end));
  return v_code;
end $$;

-- Event yang berlaku: event asli yang tidak dikoreksi + event koreksi.
create or replace function public.effective_attendance(p_shift uuid)
returns table (kind public.attendance_kind, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.kind, e.at from public.attendance_events e
  where e.shift_id = p_shift
    and not exists (select 1 from public.attendance_events c where c.corrects_id = e.id)
  order by e.at, e.id
$$;

create or replace function public.shift_minutes(p_shift uuid, p_now timestamptz default now())
returns table (net_minutes integer, break_minutes integer, gross_minutes integer)
language plpgsql stable security definer set search_path = '' as $$
declare r record; v_in timestamptz; v_out timestamptz; v_bs timestamptz; v_break numeric := 0;
begin
  for r in select * from public.effective_attendance(p_shift) loop
    if r.kind = 'clock_in' then v_in := r.at;
    elsif r.kind = 'break_start' then v_bs := r.at;
    elsif r.kind = 'break_end' and v_bs is not null then v_break := v_break + extract(epoch from r.at - v_bs) / 60; v_bs := null;
    elsif r.kind = 'clock_out' then v_out := r.at;
    end if;
  end loop;
  if v_in is null then net_minutes := 0; break_minutes := 0; gross_minutes := 0; return next; return; end if;
  if v_bs is not null then v_break := v_break + extract(epoch from coalesce(v_out, p_now) - v_bs) / 60; end if;
  gross_minutes := floor(extract(epoch from coalesce(v_out, p_now) - v_in) / 60);
  break_minutes := floor(v_break);
  net_minutes := greatest(0, gross_minutes - break_minutes);
  return next;
end $$;

-- Hitung ulang earning shift (hanya selama belum diputuskan owner).
create or replace function public._compute_earning(p_shift uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; m record; ar public.allowance_rules; br public.bonus_rules;
        v_base numeric := 0; v_bonus numeric := 0; v_hours numeric; v_reasons text[] := '{}'; v_night boolean;
begin
  select * into s from public.shifts where id = p_shift;
  select * into m from public.shift_minutes(p_shift);
  select * into ar from public.allowance_rules where effective_from <= s.planned_start order by effective_from desc limit 1;
  v_hours := m.net_minutes / 60.0;
  if s.kind = 'regular' then
    if ar.id is null then raise exception 'Aturan uang saku belum dikonfigurasi'; end if;
    v_base := round((case when ar.cap_at_target then least(v_hours, ar.target_hours) else v_hours end) / ar.target_hours * ar.amount_rp, 2);
  else
    select * into br from public.bonus_rules where effective_from <= s.planned_start order by effective_from desc limit 1;
    if br.id is null then raise exception 'Aturan bonus shift tambahan belum dikonfigurasi'; end if;
    v_night := (s.planned_end at time zone 'Asia/Jakarta')::time > br.night_starts
               or public.jkt_date(s.planned_end) > s.shift_date;
    v_bonus := round(case br.method
      when 'fixed_per_shift' then br.fixed_rp
      when 'per_net_hour' then v_hours * br.per_hour_rp
      else v_hours * case when v_night then br.night_per_hour_rp else br.day_per_hour_rp end end, 2);
  end if;
  if ar.id is not null and m.break_minutes > ar.suspicious_break_minutes then v_reasons := array_append(v_reasons, 'Istirahat melebihi batas wajar'); end if;
  if ar.id is not null and m.gross_minutes > ar.suspicious_shift_hours * 60 then v_reasons := array_append(v_reasons, 'Durasi kerja tidak wajar'); end if;
  update public.shifts set needs_review = needs_review or cardinality(v_reasons) > 0,
                           review_reasons = coalesce((select array_agg(distinct r) from unnest(review_reasons || v_reasons) r), '{}')
  where id = p_shift;
  insert into public.shift_earnings (shift_id, admin_id, kind, net_minutes, base_allowance, bonus, allowance_rule_id, bonus_rule_id)
  values (s.id, s.admin_id, s.kind, m.net_minutes, v_base, v_bonus, ar.id, br.id)
  on conflict (shift_id) do update set net_minutes = excluded.net_minutes, base_allowance = excluded.base_allowance,
    bonus = excluded.bonus, allowance_rule_id = excluded.allowance_rule_id, bonus_rule_id = excluded.bonus_rule_id, computed_at = now()
  where public.shift_earnings.status = 'pending';
end $$;

-- Absen: waktu server, urutan ditegakkan, admin dari sesi.
create or replace function public.attendance_action(p_shift uuid, p_kind public.attendance_kind) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; v_last public.attendance_kind; v_allowed public.attendance_kind[];
begin
  perform public.require_active();
  select * into s from public.shifts where id = p_shift for update;
  if not found or s.admin_id <> auth.uid() then raise exception 'Shift tidak ditemukan untuk akun ini' using errcode = '42501'; end if;
  if s.status in ('completed', 'cancelled', 'incomplete') then raise exception 'Shift sudah ditutup'; end if;

  select e.kind into v_last from public.effective_attendance(p_shift) e order by e.at desc limit 1;
  v_allowed := case
    when v_last is null then array['clock_in']::public.attendance_kind[]
    when v_last in ('clock_in', 'break_end') then array['break_start', 'clock_out']::public.attendance_kind[]
    when v_last = 'break_start' then array['break_end']::public.attendance_kind[]
    else array[]::public.attendance_kind[] end;
  if not (p_kind = any (v_allowed)) then
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

-- Owner menandai shift yang lewat tanpa absen pulang.
create or replace function public.flag_incomplete_shifts() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  perform public.require_owner();
  update public.shifts set status = 'incomplete', needs_review = true,
         review_reasons = coalesce((select array_agg(distinct r) from unnest(review_reasons || array['Absensi tidak lengkap']) r), '{}')
  where status in ('scheduled', 'in_progress') and planned_end < now() - interval '2 hours';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Klaim benefit: identitas dari sesi, satu klaim aktif per hak (dikunci index unik).
create or replace function public.claim_benefit(p_shift uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; v_ent uuid; v_at timestamptz;
begin
  perform public.require_active();
  select * into s from public.shifts where id = p_shift;
  if not found or s.admin_id <> auth.uid() then raise exception 'Shift tidak ditemukan untuk akun ini' using errcode = '42501'; end if;
  if not exists (select 1 from public.effective_attendance(p_shift) e where e.kind = 'clock_in') then
    raise exception 'Benefit bisa diambil setelah absen masuk';
  end if;
  select id into v_ent from public.benefit_entitlements where shift_id = p_shift;
  begin
    insert into public.benefit_claims (entitlement_id) values (v_ent) returning claimed_at into v_at;
  exception when unique_violation then
    raise exception 'Benefit KopKen untuk shift ini sudah diklaim' using errcode = '23505';
  end;
  perform public.write_audit('benefit.claim', 'benefit_claims', v_ent::text, null, jsonb_build_object('shift', s.code));
  return v_at;
end $$;

create or replace function public.request_attendance_fix(p_shift uuid, p_kind public.attendance_kind, p_at timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.require_active();
  if not exists (select 1 from public.shifts where id = p_shift and (admin_id = auth.uid() or public.is_owner())) then
    raise exception 'Akses ditolak' using errcode = '42501';
  end if;
  insert into public.approval_requests (kind, target_id, payload, reason)
  values ('attendance_fix', p_shift, jsonb_build_object('kind', p_kind, 'at', p_at), p_reason) returning id into v_id;
  return v_id;
end $$;

create or replace function public.request_benefit_fix(p_claim uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.require_active();
  if not exists (select 1 from public.benefit_claims where id = p_claim and voided_at is null and (admin_id = auth.uid() or public.is_owner())) then
    raise exception 'Klaim tidak ditemukan';
  end if;
  insert into public.approval_requests (kind, target_id, reason) values ('benefit_fix', p_claim, p_reason) returning id into v_id;
  return v_id;
end $$;

-- Owner memutuskan semua jenis pengajuan. Data lama tidak dihapus; perubahan = entri baru + audit.
create or replace function public.decide_approval(p_request uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.approval_requests; o public.orders; v public.vouchers; v_new public.voucher_status;
        v_orig bigint; v_kind public.attendance_kind; v_shift public.shifts; v_earning public.shift_earnings;
begin
  perform public.require_owner();
  select * into r from public.approval_requests where id = p_request for update;
  if not found or r.status <> 'pending' then raise exception 'Pengajuan tidak ditemukan atau sudah diputuskan'; end if;

  if p_approve then
    if r.kind = 'order_cancel' then
      select * into o from public.orders where id = r.target_id for update;
      if o.status <> 'confirmed' then raise exception 'Order tidak dalam status terkonfirmasi'; end if;
      update public.orders set status = 'cancelled', cancelled_at = now() where id = o.id;
      update public.voucher_usages set reversed_at = now(), reversal_request_id = r.id where order_id = o.id and reversed_at is null;
      update public.vouchers set status = 'available' where id = o.voucher_id;
      insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
      values (o.voucher_id, o.account_id, 1, 'reversal', 'available', o.code);

    elsif r.kind = 'stock_adjust' then
      select * into v from public.vouchers where id = r.target_id for update;
      v_new := (r.payload ->> 'new_status')::public.voucher_status;
      if v.status not in ('available', 'expired', 'broken') then raise exception 'Voucher sedang dipakai/dipesan'; end if;
      update public.vouchers set status = v_new where id = v.id;
      insert into public.stock_ledger (voucher_id, account_id, delta, reason, status_after, ref)
      values (v.id, v.account_id,
              case when v.status = 'available' and v_new <> 'available' then -1
                   when v.status <> 'available' and v_new = 'available' then 1 else 0 end,
              'adjust', v_new, 'APR-' || left(r.id::text, 8));

    elsif r.kind = 'attendance_fix' then
      select * into v_shift from public.shifts where id = r.target_id for update;
      select * into v_earning from public.shift_earnings where shift_id = v_shift.id;
      if v_earning.status = 'approved' and exists (
        select 1 from public.weekly_payrolls w where w.admin_id = v_shift.admin_id and w.status = 'paid'
          and v_shift.shift_date between w.period_start and w.period_end) then
        raise exception 'Periode sudah dibayar: masukkan selisih sebagai koreksi di periode berikutnya';
      end if;
      v_kind := (r.payload ->> 'kind')::public.attendance_kind;
      select e.id into v_orig from public.attendance_events e
      where e.shift_id = v_shift.id and e.kind = v_kind
        and not exists (select 1 from public.attendance_events c where c.corrects_id = e.id)
      order by e.at desc limit 1;
      insert into public.attendance_events (shift_id, kind, at, corrects_id, correction_reason)
      values (v_shift.id, v_kind, (r.payload ->> 'at')::timestamptz, v_orig, r.reason);
      if v_kind = 'clock_out' then update public.shifts set status = 'completed' where id = v_shift.id; end if;
      update public.shift_earnings set status = 'pending', decided_by = null, decided_at = null where shift_id = v_shift.id;
      if exists (select 1 from public.effective_attendance(v_shift.id) e where e.kind = 'clock_out') then
        perform public._compute_earning(v_shift.id);
      end if;

    elsif r.kind = 'benefit_fix' then
      update public.benefit_claims set voided_at = now(), void_request_id = r.id where id = r.target_id and voided_at is null;
    end if;
  end if;

  update public.approval_requests set status = case when p_approve then 'approved'::public.approval_status else 'rejected'::public.approval_status end,
         decided_by = auth.uid(), decided_at = now(), decision_note = p_note
  where id = r.id;
  perform public.write_audit(case when p_approve then 'approval.approve' else 'approval.reject' end, 'approval_requests', r.id::text,
    to_jsonb(r), jsonb_build_object('note', p_note));
end $$;

create or replace function public.decide_earning(p_earning uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.shift_earnings;
begin
  perform public.require_owner();
  select * into e from public.shift_earnings where id = p_earning for update;
  if not found or e.status <> 'pending' then raise exception 'Earning tidak ditemukan atau sudah diputuskan'; end if;
  update public.shift_earnings set status = case when p_approve then 'approved'::public.earning_status else 'rejected'::public.earning_status end,
         decided_by = auth.uid(), decided_at = now(), decision_note = p_note
  where id = e.id;
  perform public.write_audit('earning.decide', 'shift_earnings', e.id::text, to_jsonb(e), jsonb_build_object('approve', p_approve, 'note', p_note));
end $$;

-- Rekap mingguan dari earning yang sudah disetujui. Periode yang sudah disetujui/dibayar tidak dihitung ulang.
create or replace function public.build_weekly_payroll(p_admin uuid, p_period_start date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status public.payroll_status;
begin
  perform public.require_owner();
  select id, status into v_id, v_status from public.weekly_payrolls where admin_id = p_admin and period_start = p_period_start for update;
  if v_status is not null and v_status <> 'open' then
    raise exception 'Rekap periode ini sudah % dan terkunci; gunakan koreksi di periode berikutnya', v_status;
  end if;
  insert into public.weekly_payrolls as w (admin_id, period_start, regular_scheduled, regular_completed, net_minutes, base_total, bonus_total)
  select p_admin, p_period_start,
    count(*) filter (where s.kind = 'regular' and s.status <> 'cancelled'),
    count(*) filter (where s.kind = 'regular' and e.status = 'approved'),
    coalesce(sum(e.net_minutes) filter (where s.kind = 'regular' and e.status = 'approved'), 0),
    coalesce(sum(e.base_allowance) filter (where e.status = 'approved'), 0),
    coalesce(sum(e.bonus) filter (where e.status = 'approved'), 0)
  from public.shifts s left join public.shift_earnings e on e.shift_id = s.id
  where s.admin_id = p_admin and s.shift_date between p_period_start and p_period_start + 6
  on conflict (admin_id, period_start) do update set
    regular_scheduled = excluded.regular_scheduled, regular_completed = excluded.regular_completed,
    net_minutes = excluded.net_minutes, base_total = excluded.base_total, bonus_total = excluded.bonus_total, updated_at = now()
  where w.status = 'open'
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.approve_weekly_payroll(p_payroll uuid, p_adjustments jsonb default '[]') returns numeric
language plpgsql security definer set search_path = '' as $$
declare w public.weekly_payrolls; v_adj numeric; v_total numeric;
begin
  perform public.require_owner();
  select * into w from public.weekly_payrolls where id = p_payroll for update;
  if not found or w.status <> 'open' then raise exception 'Rekap tidak ditemukan atau sudah dikunci'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_adjustments, '[]')) a
             where (a ->> 'amount') is null or coalesce(length(trim(a ->> 'reason')), 0) < 3) then
    raise exception 'Setiap koreksi wajib punya nominal dan alasan';
  end if;
  select coalesce(sum((a ->> 'amount')::numeric), 0) into v_adj from jsonb_array_elements(coalesce(p_adjustments, '[]')) a;
  v_total := w.base_total + v_adj + w.bonus_total;
  if v_total < 0 then raise exception 'Total periode tidak boleh negatif; bawa selisih ke periode berikutnya'; end if;
  update public.weekly_payrolls set adjustments = coalesce(p_adjustments, '[]'), adjustment_total = v_adj,
         approved_total = v_total, status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = w.id;
  perform public.write_audit('payroll.approve', 'weekly_payrolls', w.id::text, to_jsonb(w), jsonb_build_object('total', v_total));
  return v_total;
end $$;

create or replace function public.mark_payroll_paid(p_payroll uuid, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare w public.weekly_payrolls; v_user text; v_code text;
begin
  perform public.require_owner();
  select * into w from public.weekly_payrolls where id = p_payroll for update;
  if not found or w.status <> 'approved' then raise exception 'Hanya rekap yang sudah disetujui yang bisa dicairkan'; end if;
  select username into v_user from public.profiles where id = w.admin_id;
  v_code := 'PAY-' || to_char(w.period_start, 'IYYY"W"IW') || '-' || v_user;
  insert into public.payouts (code, payroll_id, amount, note) values (v_code, w.id, w.approved_total, p_note);  -- unik per periode
  update public.weekly_payrolls set status = 'paid', updated_at = now() where id = w.id;
  perform public.write_audit('payroll.paid', 'weekly_payrolls', w.id::text, null, jsonb_build_object('payout', v_code, 'amount', w.approved_total));
  return v_code;
end $$;

-- Rekap yang sudah dibayar tidak bisa diubah.
create or replace function public.lock_paid_payroll() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'paid' then raise exception 'Rekap yang sudah dibayar terkunci' using errcode = '42501'; end if;
  return new;
end $$;
create trigger weekly_payrolls_lock before update or delete on public.weekly_payrolls
  for each row execute function public.lock_paid_payroll();

-- Pengelolaan akun staf oleh owner. Pembuatan akun & reset password lewat route server (service role).
create or replace function public.set_staff_active(p_profile uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_before public.profiles;
begin
  perform public.require_owner();
  if p_profile = auth.uid() then raise exception 'Owner tidak bisa menonaktifkan akunnya sendiri'; end if;
  select * into v_before from public.profiles where id = p_profile for update;
  update public.profiles set is_active = p_active where id = p_profile;
  if not p_active then delete from auth.sessions where user_id = p_profile; end if;  -- cabut sesi aktif
  perform public.write_audit('staff.set_active', 'profiles', p_profile::text, to_jsonb(v_before), jsonb_build_object('is_active', p_active));
end $$;

create or replace function public.set_staff_permission(p_profile uuid, p_can_restock boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner();
  update public.profiles set can_restock_panel = p_can_restock where id = p_profile and role = 'staff';
  perform public.write_audit('staff.set_permission', 'profiles', p_profile::text, null, jsonb_build_object('can_restock_panel', p_can_restock));
end $$;

-- Dipanggil route reset password setelah memastikan pemanggil owner.
create or replace function public.revoke_sessions(p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner();
  delete from auth.sessions where user_id = p_profile;
  update public.profiles set must_change_password = true where id = p_profile;
  perform public.write_audit('staff.reset_password', 'profiles', p_profile::text, null, null);
end $$;

-- Hak eksekusi: cabut default (PUBLIC, anon, authenticated), lalu beri hanya fungsi API ke pengguna login.
-- Fungsi internal berawalan _ tidak bisa dipanggil klien.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.current_app_role(), public.is_owner(), public.is_active_user(), public.can_restock_panel(),
  public.panel_add_account(text, text, text, date, jsonb, uuid),
  public.vm_add_account(text, text, text, date, jsonb, uuid),
  public.vm_add_device(text, text),
  public.vm_update_account(uuid, text, text, date),
  public.add_stock(uuid, jsonb, uuid),
  public.record_order(uuid, text, text, text, integer, integer, integer, integer, integer, boolean, uuid),
  public.confirm_draft(uuid), public.cancel_draft(uuid),
  public.request_order_cancel(uuid, text),
  public.request_stock_adjust(uuid, public.voucher_status, text),
  public.generate_regular_shifts(date), public.add_extra_shift(uuid, timestamptz, timestamptz),
  public.shift_minutes(uuid, timestamptz),
  public.attendance_action(uuid, public.attendance_kind), public.flag_incomplete_shifts(),
  public.claim_benefit(uuid), public.request_attendance_fix(uuid, public.attendance_kind, timestamptz, text),
  public.request_benefit_fix(uuid, text), public.decide_approval(uuid, boolean, text),
  public.decide_earning(uuid, boolean, text), public.build_weekly_payroll(uuid, date),
  public.approve_weekly_payroll(uuid, jsonb), public.mark_payroll_paid(uuid, text),
  public.set_staff_active(uuid, boolean), public.set_staff_permission(uuid, boolean), public.revoke_sessions(uuid)
to authenticated;

-- Fungsi bantu yang dipakai di kebijakan RLS & view perlu bisa dievaluasi oleh pengguna login.
grant execute on function public.mask_tail(text), public.jkt_date(timestamptz) to authenticated;
