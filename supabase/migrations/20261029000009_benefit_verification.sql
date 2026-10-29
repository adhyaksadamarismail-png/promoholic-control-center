-- Benefit KopKen: ukuran cup wajib dipilih, bukti receipt wajib (storage privat), dan verifikasi owner.
-- Non-destruktif: kolom ditambah, klaim lama tetap ada dan ditandai sebagai klaim sebelum aturan baru.

alter table public.benefit_claims
  add column shift_id uuid references public.shifts (id),
  add column cup_size text check (cup_size in ('regular', 'large')),
  add column receipt_path text,
  add column status text,
  add column verified_by uuid references public.profiles (id),
  add column verified_at timestamptz,
  add column review_note text,
  add column receipt_viewed_by uuid references public.profiles (id),
  add column receipt_viewed_at timestamptz;

-- Klaim lama (sebelum bukti wajib) tetap dihitung sebagai sudah diambil, dengan catatan jelas.
update public.benefit_claims c set shift_id = e.shift_id,
  status = 'verified', review_note = 'Klaim lama sebelum ukuran cup & bukti receipt wajib'
from public.benefit_entitlements e where e.id = c.entitlement_id;

alter table public.benefit_claims
  alter column status set default 'pending',
  alter column status set not null,
  add constraint benefit_claims_status_check check (status in ('pending', 'verified', 'rejected')),
  add constraint benefit_claims_reject_reason check (status <> 'rejected' or length(trim(coalesce(review_note, ''))) >= 3),
  add constraint benefit_claims_verified_by check (status = 'pending' or verified_by is not null or review_note like 'Klaim lama%');
create unique index benefit_claims_receipt_unique on public.benefit_claims (receipt_path) where receipt_path is not null;

-- Satu klaim aktif per shift: pengajuan yang menunggu atau sudah terverifikasi. Klaim ditolak boleh diajukan ulang
-- sebagai baris baru (yang lama tetap tercatat).
drop index public.benefit_one_active_claim;
create unique index benefit_one_active_claim on public.benefit_claims (entitlement_id)
  where voided_at is null and status in ('pending', 'verified');

-- Storage privat untuk receipt: tidak publik, maks 5 MB, hanya JPG/PNG/WebP.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('benefit-receipts', 'benefit-receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Path: <admin_id>/<shift_id>/<file>. Admin hanya bisa menaruh & membaca di foldernya sendiri; owner membaca semua.
-- Tidak ada policy update/delete: bukti tidak bisa diganti setelah diunggah (pembersihan oleh server).
create policy benefit_receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'benefit-receipts' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active_user());
create policy benefit_receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'benefit-receipts' and public.is_active_user()
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_owner()));

-- Klaim lama tanpa ukuran & bukti tidak bisa dipakai lagi oleh klien.
create or replace function public.claim_benefit(p_shift uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Ajukan pengambilan dengan memilih ukuran cup dan mengunggah bukti receipt';
end $$;
revoke all on function public.claim_benefit(uuid) from public, anon, authenticated;

create or replace function public.submit_benefit_claim(p_shift uuid, p_cup_size text, p_receipt_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; v_ent uuid; v_id uuid;
begin
  perform public.require_active();
  select * into s from public.shifts where id = p_shift;
  if not found or s.admin_id <> auth.uid() then raise exception 'Shift tidak ditemukan untuk akun ini' using errcode = '42501'; end if;
  -- Hak benefit dari data absensi: shift harus sudah absen masuk dan tidak dibatalkan.
  if s.status = 'cancelled' then raise exception 'Shift dibatalkan: tidak ada hak benefit'; end if;
  if not exists (select 1 from public.effective_attendance(p_shift) e where e.kind = 'clock_in') then
    raise exception 'Benefit bisa diajukan setelah absen masuk';
  end if;
  if p_cup_size is null or p_cup_size not in ('regular', 'large') then raise exception 'Pilih ukuran cup: Regular atau Large'; end if;
  if p_receipt_path is null
     or (storage.foldername(p_receipt_path))[1] <> auth.uid()::text
     or (storage.foldername(p_receipt_path))[2] <> p_shift::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'benefit-receipts' and o.name = p_receipt_path) then
    raise exception 'Bukti receipt tidak ditemukan. Unggah ulang gambarnya';
  end if;
  select id into v_ent from public.benefit_entitlements where shift_id = p_shift;
  if v_ent is null then raise exception 'Shift ini tidak punya hak benefit'; end if;
  begin
    insert into public.benefit_claims (entitlement_id, shift_id, cup_size, receipt_path, status)
    values (v_ent, p_shift, p_cup_size, p_receipt_path, 'pending') returning id into v_id;
  exception when unique_violation then
    raise exception 'Benefit shift ini sudah diajukan (menunggu verifikasi) atau sudah terverifikasi' using errcode = '23505';
  end;
  perform public.write_audit('benefit.submit', 'benefit_claims', v_id::text, null,
    jsonb_build_object('shift', s.code, 'cup_size', p_cup_size, 'status', 'pending'));
  return v_id;
end $$;

-- Dicatat saat owner membuka bukti lewat aplikasi; persetujuan mensyaratkan bukti sudah dibuka.
create or replace function public.mark_benefit_receipt_viewed(p_claim uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_owner();
  update public.benefit_claims set receipt_viewed_by = auth.uid(), receipt_viewed_at = now() where id = p_claim;
end $$;

create or replace function public.verify_benefit_claim(p_claim uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.benefit_claims;
begin
  perform public.require_owner();
  select * into c from public.benefit_claims where id = p_claim for update;  -- kunci: cegah persetujuan ganda
  if not found then raise exception 'Klaim tidak ditemukan'; end if;
  if c.voided_at is not null then raise exception 'Klaim sudah dibatalkan'; end if;
  if c.status <> 'pending' then raise exception 'Klaim sudah diputuskan (%)', c.status; end if;
  if p_approve and c.receipt_viewed_at is null then
    raise exception 'Buka dan periksa bukti receipt sebelum menyetujui';
  end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Alasan penolakan wajib diisi'; end if;
  update public.benefit_claims
  set status = case when p_approve then 'verified' else 'rejected' end,
      verified_by = auth.uid(), verified_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '')
  where id = c.id;
  perform public.write_audit(case when p_approve then 'benefit.verify' else 'benefit.reject' end, 'benefit_claims', c.id::text,
    jsonb_build_object('status', c.status), jsonb_build_object('status', case when p_approve then 'verified' else 'rejected' end, 'note', p_note));
end $$;

revoke all on function public.submit_benefit_claim(uuid, text, text), public.mark_benefit_receipt_viewed(uuid),
  public.verify_benefit_claim(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.submit_benefit_claim(uuid, text, text), public.mark_benefit_receipt_viewed(uuid),
  public.verify_benefit_claim(uuid, boolean, text) to authenticated;
