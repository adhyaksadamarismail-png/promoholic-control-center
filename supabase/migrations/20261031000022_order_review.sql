-- Tinjauan order: order bertanda "Perlu tinjau owner" masuk antrean Persetujuan yang sudah ada.
-- Sumber antrean tetap approval_requests; orders.needs_review berarti "masih menunggu keputusan owner".
-- Setujui/Tolak hanya mencatat keputusan: angka order, voucher, dan Keuangan tidak berubah.
-- Alasan awal (review_reasons) dan riwayat keputusan tetap tersimpan.

alter table public.orders add column review_status text check (review_status in ('approved', 'rejected'));

-- 1. Antrean mengikuti status order. Satu trigger untuk semua jalur: record_order, confirm_draft,
-- persetujuan pembatalan, dan cancel_order_now.
create or replace function public._order_review_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'confirmed' and new.needs_review and (tg_op = 'INSERT' or old.status <> 'confirmed') then
    insert into public.approval_requests (kind, target_id, reason, requested_by)
    values ('order_review', new.id, coalesce(nullif(array_to_string(new.review_reasons, '; '), ''), 'Ditandai sistem'), new.admin_id)
    on conflict do nothing;
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.approval_requests set status = 'closed', decided_by = auth.uid(), decided_at = now(),
           decision_note = 'Ditutup otomatis: order dibatalkan'
    where kind = 'order_review' and target_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
create trigger orders_review_sync after insert or update of status on public.orders
  for each row execute function public._order_review_sync();

-- 2. Order terkonfirmasi yang sudah bertanda sebelum migrasi ini. Order yang dibatalkan tidak perlu ditinjau.
insert into public.approval_requests (kind, target_id, reason, requested_by, requested_at)
select 'order_review', o.id, coalesce(nullif(array_to_string(o.review_reasons, '; '), ''), 'Ditandai sistem'), o.admin_id,
       coalesce(o.confirmed_at, o.created_at)
from public.orders o where o.status = 'confirmed' and o.needs_review
on conflict do nothing;

-- 3. Keputusan owner. Sama dengan versi sebelumnya, ditambah cabang order_review.
create or replace function public.decide_approval(p_request uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.approval_requests; o public.orders; v public.vouchers; v_new public.voucher_status;
        v_orig bigint; v_kind public.attendance_kind; v_shift public.shifts; v_earning public.shift_earnings;
begin
  perform public.require_owner();
  select * into r from public.approval_requests where id = p_request for update;
  if not found or r.status <> 'pending' then raise exception 'Pengajuan tidak ditemukan atau sudah diputuskan'; end if;

  -- Tinjauan order: hanya mencatat keputusan. Angka order, voucher, dan Keuangan tidak berubah.
  if r.kind = 'order_review' then
    if not p_approve and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Tulis alasan penolakan'; end if;
    select * into o from public.orders where id = r.target_id for update;
    if not found or o.status <> 'confirmed' then raise exception 'Order tidak dalam status terkonfirmasi'; end if;
    update public.orders set needs_review = false, review_status = case when p_approve then 'approved' else 'rejected' end where id = o.id;
  end if;

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

-- Hak eksekusi -------------------------------------------------------------
revoke all on function public._order_review_sync() from public, anon, authenticated;
