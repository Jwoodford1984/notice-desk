-- RLS and workflow checks. Run after migrations + seed on a test database.
-- Each check raises an exception on failure; success prints PASS lines.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'admin@northgate-demo.example'),
  ('22222222-2222-4222-8222-222222222222', 'viewer@northgate-demo.example'),
  ('33333333-3333-4333-8333-333333333333', 'outsider@other-demo.example');
insert into public.tenant_members(tenant_id, user_id, role) values
  ('00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'admin'),
  ('00000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'viewer');

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;

-- 1. Outsider creates their own workspace and sees only that
select pg_temp.as_user('33333333-3333-4333-8333-333333333333');
select public.create_tenant('Other Bank (demo)', 'other-demo');
select pg_temp.check((select count(*) from public.tenants) = 1, 'outsider sees only their own tenant');
select pg_temp.check((select count(*) from public.notices) = 0, 'outsider sees no Northgate notices');
select pg_temp.check((select count(*) from public.usage_items) = 0, 'outsider sees no Northgate usage');
select pg_temp.check((select count(*) from public.notice_impact) = 0, 'outsider sees nothing in impact view');

-- Outsider cannot insert into Northgate
do $$ begin
  insert into public.notices(tenant_id, ref, vendor, title) values ('00000000-0000-4000-8000-000000000001', 'X-1', 'LSEG', 'Injected');
  raise exception 'FAIL: outsider inserted into another tenant';
exception when insufficient_privilege then raise notice 'PASS: outsider blocked from inserting into another tenant';
end $$;

-- Outsider cannot link a notice in their tenant to a Northgate file (composite FK)
do $$
declare v_t uuid := (select id from public.tenants where slug = 'other-demo');
begin
  insert into public.notices(id, tenant_id, ref, vendor, title, requires_file) values ('44444444-4444-4444-8444-444444444444', v_t, 'O-1', 'LSEG', 'Own notice', true);
  insert into public.notice_instruments(tenant_id, notice_id, file_id, vendor, current_code)
  values (v_t, '44444444-4444-4444-8444-444444444444', '00000000-0000-4000-8000-000000000200', 'LSEG', 'X=Y');
  raise exception 'FAIL: cross-tenant file link allowed';
exception when foreign_key_violation then raise notice 'PASS: cross-tenant file link rejected';
end $$;
select pg_temp.check((select status from public.notices where ref = 'O-1') = 'awaiting_file', 'new notice needing a file starts as awaiting_file');
reset role;

-- 2. Viewer reads but cannot write
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select pg_temp.check((select count(*) from public.notices) = 7, 'viewer sees the 7 Northgate notices');
update public.actions set status = 'done';
select pg_temp.check((select count(*) from public.actions where status <> 'done') = 2, 'viewer update changes nothing');
select pg_temp.check((select count(*) from public.audit_log) = 0, 'viewer cannot read audit log');
reset role;

-- 3. Admin workflow: exchange-level actions, then close
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.check(public.create_actions_for_notice((select id from public.notices where ref = 'EX-CME-26-41')) = 6,
  'CME fee notice creates 6 actions (4 people, 2 application teams)');
select pg_temp.check(public.create_actions_for_notice((select id from public.notices where ref = 'EX-CME-26-41')) = 0,
  'running it again creates no duplicates');
select pg_temp.check((select status from public.notices where ref = 'EX-CME-26-41') = 'in_review', 'notice moves to in_review');
select pg_temp.check((select due_date from public.actions a join public.notices n on n.id = a.notice_id where n.ref = 'EX-CME-26-41' limit 1) = date '2026-12-27',
  'due date is 5 days before effective');
update public.actions set status = 'done' where notice_id = (select id from public.notices where ref = 'EX-CME-26-41');
select pg_temp.check((select status from public.notices where ref = 'EX-CME-26-41') = 'actioned', 'all actions done closes the notice');
select pg_temp.check((select count(*) from public.audit_log where table_name = 'actions') > 0, 'admin can read audit log');

-- Bloomberg ticker matching normalises case and spacing
select pg_temp.check(exists (select 1 from public.notice_instrument_matches m join public.notices n on n.id = m.notice_id
                             where n.ref = 'BBG-26-118' and m.used_item = 'ngb7  pw equity' and m.current_code = 'NGB7 PW Equity'),
  'B-PIPE ticker "ngb7  pw equity" matches "NGB7 PW Equity"');

-- Uploading a new usage file swaps the current source atomically
insert into public.data_sources(id, tenant_id, kind, file_name) values
  ('55555555-5555-4555-8555-555555555555', '00000000-0000-4000-8000-000000000001', 'lseg_usage', 'new_usage.csv');
insert into public.usage_items(tenant_id, source_id, vendor, login, item) values
  ('00000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'LSEG', 'hlena', 'ITEEU5Y36A=MP');
select pg_temp.check((select used_direct from public.notice_impact where ref = 'DN-26-1142') = 5, 'half-loaded source is not used for matching');
select public.activate_source('55555555-5555-4555-8555-555555555555');
select pg_temp.check((select count(*) from public.data_sources where kind = 'lseg_usage' and is_current) = 1, 'exactly one current usage source');
select pg_temp.check((select used_direct from public.notice_impact where ref = 'DN-26-1142') = 1, 'matching uses the newly activated source');

-- Storage: paths must start with a tenant the user belongs to
insert into storage.objects(bucket_id, name) values ('notice-files', '00000000-0000-4000-8000-000000000001/DN-26-1163/file.xlsx');
do $$ begin
  insert into storage.objects(bucket_id, name) values ('notice-files', gen_random_uuid()::text || '/x.xlsx');
  raise exception 'FAIL: wrote into a tenant folder the user does not belong to';
exception when insufficient_privilege then raise notice 'PASS: storage write into another tenant folder blocked';
end $$;
reset role;

rollback;
