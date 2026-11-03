-- Notice Desk: complete setup for the Supabase SQL Editor (fresh projects only)
-- Paste this whole file into Dashboard -> SQL Editor -> New query, and run it once.
-- It creates the schema, security rules and storage buckets, then loads the demo workspace.

-- ===== 20261103090000_core_schema.sql =====
-- Notice Desk: core schema
-- Multi-tenant: every business table carries tenant_id, and child tables use
-- composite foreign keys (id, tenant_id) so rows can never point across tenants.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.member_role   as enum ('admin', 'member', 'viewer');
create type public.source_kind   as enum ('lseg_usage', 'lseg_permissions', 'bpipe_usage');
create type public.notice_kind   as enum ('ric', 'ticker', 'exchange');
create type public.notice_status as enum ('new', 'awaiting_file', 'matched', 'in_review', 'actioned', 'not_relevant');
create type public.action_status as enum ('open', 'in_progress', 'done');

-- ---------------------------------------------------------------------------
-- Code normalisation (immutable so it can drive generated columns)
--   LSEG:      strip a leading "/" (delayed RIC prefix), trim. Case-sensitive.
--   Bloomberg: trim, collapse whitespace, upper-case ("vod ln  equity" -> "VOD LN EQUITY").
-- ---------------------------------------------------------------------------
create or replace function public.normalise_code(code text, vendor text)
returns text language sql immutable parallel safe as $$
  select case
    when code is null then null
    when vendor = 'Bloomberg' then upper(regexp_replace(btrim(code), '\s+', ' ', 'g'))
    else regexp_replace(btrim(code), '^/', '')
  end
$$;

-- Chain RICs ("0#ITEEU10Y24T=MP", "3#EUR1=JSPN") -> the underlying code after "n#".
create or replace function public.chain_base(code text, vendor text)
returns text language sql immutable parallel safe as $$
  select case
    when vendor = 'LSEG' and public.normalise_code(code, vendor) ~ '^[0-9]#.+'
      then substring(public.normalise_code(code, vendor) from '^[0-9]#(.+)$')
    else null
  end
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  created_at  timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.member_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members(user_id);

-- ---------------------------------------------------------------------------
-- Data sources: one row per uploaded DACS / B-PIPE file. Exactly one current
-- source per (tenant, kind); matching only ever reads current sources.
-- ---------------------------------------------------------------------------
create table public.data_sources (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  kind            public.source_kind not null,
  file_name       text not null,
  storage_path    text,
  report_version  text,
  generated_label text,
  period_label    text,
  row_count       integer not null default 0,
  warnings        jsonb not null default '[]'::jsonb,
  is_current      boolean not null default false,
  uploaded_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (id, tenant_id)
);
create unique index data_sources_one_current
  on public.data_sources(tenant_id, kind) where is_current;

create table public.usage_items (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null,
  source_id     uuid not null,
  vendor        text not null check (vendor in ('LSEG', 'Bloomberg')),
  login         text not null,
  user_name     text,
  user_group    text,
  cost_centre   text,
  email         text,
  service_code  text,
  service_desc  text,
  item          text not null,
  item_norm     text generated always as (public.normalise_code(item, vendor)) stored,
  chain_base    text generated always as (public.chain_base(item, vendor)) stored,
  foreign key (source_id, tenant_id) references public.data_sources(id, tenant_id) on delete cascade
);
create index usage_items_match_idx on public.usage_items(tenant_id, vendor, item_norm);
create index usage_items_chain_idx on public.usage_items(tenant_id, vendor, chain_base) where chain_base is not null;
create index usage_items_source_idx on public.usage_items(source_id);

create table public.permissions (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null,
  source_id      uuid not null,
  login          text not null,
  user_name      text,
  email          text,
  service_code   text not null,
  service_desc   text,
  fee_structure  text,
  activated_label text,
  foreign key (source_id, tenant_id) references public.data_sources(id, tenant_id) on delete cascade
);
create index permissions_service_idx on public.permissions(tenant_id, service_code);
create index permissions_login_idx on public.permissions(tenant_id, login);
create index permissions_source_idx on public.permissions(source_id);

-- Services mapped to the whole site (the DACS "mapsite" section), not to a login.
create table public.site_services (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null,
  source_id      uuid not null,
  site_name      text,
  service_code   text not null,
  service_desc   text,
  fee_structure  text,
  foreign key (source_id, tenant_id) references public.data_sources(id, tenant_id) on delete cascade
);

-- System logins mapped to an application and an owning team, so actions are
-- routed to people who can fix the application.
create table public.applications (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  login        text not null,
  name         text not null,
  owner_team   text,
  owner_email  text,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, login)
);

-- ---------------------------------------------------------------------------
-- Notices
-- ---------------------------------------------------------------------------
create table public.notices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  ref            text not null,
  vendor         text not null,
  source         text,
  title          text not null,
  change_type    text,
  kind           public.notice_kind not null default 'ric',
  effective_date date,
  received_date  date not null default current_date,
  service_codes  text[] not null default '{}',
  requires_file  boolean not null default true,
  status         public.notice_status not null default 'new',
  portal_url     text,
  summary        text,
  raw_text       text,
  created_by     uuid references auth.users(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, ref),
  unique (id, tenant_id)
);
create index notices_effective_idx on public.notices(tenant_id, effective_date);

create table public.notice_files (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  notice_id        uuid not null,
  file_name        text not null,
  storage_path     text,
  sheet_name       text,
  detected_columns jsonb not null default '{}'::jsonb,
  row_count        integer not null default 0,
  is_current       boolean not null default true,
  uploaded_by      uuid references auth.users(id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (notice_id, tenant_id) references public.notices(id, tenant_id) on delete cascade
);
create unique index notice_files_one_current on public.notice_files(notice_id) where is_current;

create table public.notice_instruments (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null,
  notice_id       uuid not null,
  file_id         uuid not null,
  vendor          text not null check (vendor in ('LSEG', 'Bloomberg')),
  current_code    text not null,
  new_code        text,
  change_type     text,
  effective_label text,
  code_norm       text generated always as (public.normalise_code(current_code, vendor)) stored,
  foreign key (notice_id, tenant_id) references public.notices(id, tenant_id) on delete cascade,
  foreign key (file_id, tenant_id) references public.notice_files(id, tenant_id) on delete cascade
);
create index notice_instruments_notice_idx on public.notice_instruments(notice_id);
create index notice_instruments_code_idx on public.notice_instruments(tenant_id, vendor, code_norm);

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------
create table public.actions (
  id           uuid primary key default gen_random_uuid(),
  number       bigint generated always as identity,
  tenant_id    uuid not null,
  notice_id    uuid not null,
  owner_key    text not null,
  owner_name   text not null,
  owner_email  text,
  is_app       boolean not null default false,
  logins       text[] not null default '{}',
  items        text[] not null default '{}',
  due_date     date,
  status       public.action_status not null default 'open',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (notice_id, owner_key),
  foreign key (notice_id, tenant_id) references public.notices(id, tenant_id) on delete cascade
);
create index actions_tenant_status_idx on public.actions(tenant_id, status, due_date);

-- ---------------------------------------------------------------------------
-- Audit log (written by triggers only)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  table_name  text not null,
  row_id      text not null,
  operation   text not null,
  changed_by  uuid default auth.uid(),
  changed_at  timestamptz not null default now(),
  old_row     jsonb,
  new_row     jsonb
);
create index audit_log_tenant_idx on public.audit_log(tenant_id, changed_at desc);

-- ===== 20261103090100_logic.sql =====
-- Notice Desk: triggers, matching views and RPCs

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger notices_updated_at  before update on public.notices  for each row execute function public.set_updated_at();
create trigger actions_updated_at  before update on public.actions  for each row execute function public.set_updated_at();
create trigger apps_updated_at     before update on public.applications for each row execute function public.set_updated_at();

create or replace function public.write_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_log(tenant_id, table_name, row_id, operation, old_row, new_row)
  values ((r->>'tenant_id')::uuid, tg_table_name, r->>'id', tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger notices_audit after insert or update or delete on public.notices for each row execute function public.write_audit();
create trigger actions_audit after insert or update or delete on public.actions for each row execute function public.write_audit();
create trigger notice_files_audit after insert or delete on public.notice_files for each row execute function public.write_audit();
create trigger data_sources_audit after insert or update of is_current or delete on public.data_sources for each row execute function public.write_audit();

-- ---------------------------------------------------------------------------
-- Only one current data source per (tenant, kind)
-- ---------------------------------------------------------------------------
create or replace function public.data_sources_single_current()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_current then
    update public.data_sources
       set is_current = false
     where tenant_id = new.tenant_id and kind = new.kind and id <> new.id and is_current;
  end if;
  return new;
end $$;

create trigger data_sources_single_current
  before insert or update of is_current on public.data_sources
  for each row execute function public.data_sources_single_current();

-- ---------------------------------------------------------------------------
-- Attaching a notice file replaces the previous one and moves the notice on
-- ---------------------------------------------------------------------------
create or replace function public.notice_files_on_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_current then
    update public.notice_files set is_current = false
     where notice_id = new.notice_id and id <> new.id and is_current;
  end if;
  return new;
end $$;

create trigger notice_files_single_current
  before insert on public.notice_files
  for each row execute function public.notice_files_on_insert();

create or replace function public.notice_files_after_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.notices
     set status = 'matched'
   where id = new.notice_id and status in ('new', 'awaiting_file');
  return new;
end $$;

create trigger notice_files_advance_status
  after insert on public.notice_files
  for each row execute function public.notice_files_after_insert();

-- New notices that need a file start in awaiting_file
create or replace function public.notices_initial_status()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.requires_file and new.status = 'new' then
    new.status := 'awaiting_file';
  end if;
  return new;
end $$;

create trigger notices_initial_status
  before insert on public.notices
  for each row execute function public.notices_initial_status();

-- When every action on a notice is done, the notice is actioned
create or replace function public.actions_close_notice()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'done' and not exists (
       select 1 from public.actions a where a.notice_id = new.notice_id and a.status <> 'done') then
    update public.notices set status = 'actioned'
     where id = new.notice_id and status not in ('actioned', 'not_relevant');
  end if;
  return new;
end $$;

create trigger actions_close_notice
  after update of status on public.actions
  for each row execute function public.actions_close_notice();

-- ---------------------------------------------------------------------------
-- Views (security_invoker so the caller's RLS applies)
-- ---------------------------------------------------------------------------

-- Who a login is and where to send their actions.
-- Email preference: current permission file, then current usage file.
create or replace view public.login_directory with (security_invoker = true) as
with logins as (
  select p.tenant_id, p.login, p.user_name, nullif(p.email, '') as email, null::text as cost_centre, 1 as pri
    from public.permissions p join public.data_sources s on s.id = p.source_id and s.is_current
  union all
  select u.tenant_id, u.login, u.user_name, nullif(u.email, ''), u.cost_centre, 2
    from public.usage_items u join public.data_sources s on s.id = u.source_id and s.is_current
),
agg as (
  select tenant_id, login,
         (array_agg(user_name order by pri) filter (where user_name is not null))[1] as user_name,
         (array_agg(email order by pri) filter (where email is not null))[1] as email,
         (array_agg(cost_centre) filter (where cost_centre is not null))[1] as cost_centre
    from logins group by tenant_id, login
)
select a.tenant_id, a.login, a.user_name, a.email, a.cost_centre,
       (app.login is not null) as is_app,
       app.name as app_name,
       coalesce(app.owner_team, app.name, a.user_name, a.login) as route_to,
       coalesce(app.owner_email, a.email) as route_email,
       case when app.login is not null then 'app:' || coalesce(app.owner_team, app.login)
            else 'user:' || a.login end as owner_key
  from agg a
  left join public.applications app on app.tenant_id = a.tenant_id and app.login = a.login;

-- Logins that look like systems but aren't mapped to an application yet
create or replace view public.application_candidates with (security_invoker = true) as
select d.tenant_id, d.login, d.user_name
  from public.login_directory d
 where not d.is_app
   and d.login ~* '(_prd|_prod|_uat|_tst|_test|_dev|_gtu)$|^(rtds|murex|bpipe|svc)_|^(courbes|bfn)$';

-- Every instrument in a notice's current file that appears in current usage
create or replace view public.notice_instrument_matches with (security_invoker = true) as
select ni.tenant_id, ni.notice_id, ni.id as instrument_id,
       ni.current_code, ni.new_code, ni.change_type,
       u.login, u.user_name, u.cost_centre, u.service_code, u.item as used_item,
       case when u.item_norm = ni.code_norm then 'direct' else 'chain' end as match_type
  from public.notice_instruments ni
  join public.notice_files f on f.id = ni.file_id and f.is_current
  join public.usage_items u
    on u.tenant_id = ni.tenant_id and u.vendor = ni.vendor
   and (u.item_norm = ni.code_norm or u.chain_base = ni.code_norm)
  join public.data_sources s on s.id = u.source_id and s.is_current;

-- Logins permissioned for the services a notice names
create or replace view public.notice_permission_matches with (security_invoker = true) as
select n.tenant_id, n.id as notice_id, p.login, p.user_name, p.email,
       p.service_code, p.fee_structure
  from public.notices n
  join public.permissions p on p.tenant_id = n.tenant_id and p.service_code = any(n.service_codes)
  join public.data_sources s on s.id = p.source_id and s.is_current;

-- One row per notice with impact counts, for the inbox and dashboard
create or replace view public.notice_impact with (security_invoker = true) as
select n.tenant_id, n.id as notice_id, n.ref, n.vendor, n.title, n.kind, n.status,
       n.effective_date, n.effective_date - current_date as days_to_effective,
       (select f.id from public.notice_files f where f.notice_id = n.id and f.is_current) as current_file_id,
       (select count(*) from public.notice_instruments ni
          join public.notice_files f on f.id = ni.file_id and f.is_current
         where ni.notice_id = n.id) as instruments,
       (select count(distinct m.instrument_id) from public.notice_instrument_matches m
         where m.notice_id = n.id and m.match_type = 'direct') as used_direct,
       (select count(distinct m.instrument_id) from public.notice_instrument_matches m
         where m.notice_id = n.id
           and not exists (select 1 from public.notice_instrument_matches d
                            where d.instrument_id = m.instrument_id and d.match_type = 'direct')) as used_via_chain,
       (select count(distinct m.login) from public.notice_instrument_matches m where m.notice_id = n.id) as logins_affected,
       (select count(distinct m.cost_centre) from public.notice_instrument_matches m where m.notice_id = n.id) as cost_centres,
       (select count(distinct pm.login) from public.notice_permission_matches pm where pm.notice_id = n.id) as logins_permissioned,
       (select count(*) from public.actions a where a.notice_id = n.id and a.status <> 'done') as open_actions
  from public.notices n;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a tenant and make the caller its admin
create or replace function public.create_tenant(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in before creating a workspace';
  end if;
  insert into public.tenants(name, slug) values (p_name, p_slug) returning id into v_id;
  insert into public.tenant_members(tenant_id, user_id, role) values (v_id, auth.uid(), 'admin');
  return v_id;
end $$;

-- Create one action per affected owner. People get their own action; logins
-- mapped to an application are grouped under the owning team.
-- Runs as the caller, so RLS decides whether they may read and insert.
create or replace function public.create_actions_for_notice(p_notice_id uuid, p_days_before integer default 5)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_notice public.notices;
  v_has_file boolean;
  v_count integer;
begin
  select * into v_notice from public.notices where id = p_notice_id;
  if not found then
    raise exception 'Notice % not found or not visible to you', p_notice_id;
  end if;

  select exists (select 1 from public.notice_files where notice_id = p_notice_id and is_current) into v_has_file;

  with affected as (
    select m.login, m.current_code as item
      from public.notice_instrument_matches m
     where m.notice_id = p_notice_id and v_has_file
    union
    select pm.login, null
      from public.notice_permission_matches pm
     where pm.notice_id = p_notice_id and not v_has_file
  ),
  grouped as (
    select d.owner_key,
           min(d.route_to) as owner_name,
           min(d.route_email) as owner_email,
           bool_or(d.is_app) as is_app,
           array_agg(distinct a.login order by a.login) as logins,
           coalesce(array_agg(distinct a.item order by a.item) filter (where a.item is not null), '{}') as items
      from affected a
      join public.login_directory d on d.tenant_id = v_notice.tenant_id and d.login = a.login
     group by d.owner_key
  ),
  ins as (
    insert into public.actions(tenant_id, notice_id, owner_key, owner_name, owner_email, is_app, logins, items, due_date)
    select v_notice.tenant_id, p_notice_id, g.owner_key, g.owner_name, g.owner_email, g.is_app, g.logins, g.items,
           v_notice.effective_date - p_days_before
      from grouped g
    on conflict (notice_id, owner_key) do nothing
    returning 1
  )
  select count(*) into v_count from ins;

  if v_count > 0 then
    update public.notices set status = 'in_review'
     where id = p_notice_id and status in ('new', 'awaiting_file', 'matched');
  end if;
  return v_count;
end $$;

-- Make an uploaded source the current one (called by the parse-source function
-- after all rows are inserted, so matching never sees a half-loaded file)
create or replace function public.activate_source(p_source_id uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.data_sources set is_current = true where id = p_source_id;
$$;

-- ===== 20261103090200_rls.sql =====
-- Notice Desk: row level security
-- Members see their tenant's rows. Viewers read only; members and admins write.
-- Membership changes are admin-only.

create or replace function public.has_role(p_tenant uuid, p_min public.member_role default 'viewer')
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_members m
     where m.tenant_id = p_tenant
       and m.user_id = (select auth.uid())
       and case p_min
             when 'viewer' then true
             when 'member' then m.role in ('member', 'admin')
             when 'admin'  then m.role = 'admin'
           end
  )
$$;

revoke all on function public.has_role(uuid, public.member_role) from public, anon;
grant execute on function public.has_role(uuid, public.member_role) to authenticated;

-- Tenants and members ---------------------------------------------------------
alter table public.tenants enable row level security;
create policy tenants_select on public.tenants for select to authenticated using (public.has_role(id));
create policy tenants_update on public.tenants for update to authenticated using (public.has_role(id, 'admin')) with check (public.has_role(id, 'admin'));
-- Tenants are created through create_tenant(); no direct insert policy.

alter table public.tenant_members enable row level security;
create policy members_select on public.tenant_members for select to authenticated using (public.has_role(tenant_id));
create policy members_insert on public.tenant_members for insert to authenticated with check (public.has_role(tenant_id, 'admin'));
create policy members_update on public.tenant_members for update to authenticated using (public.has_role(tenant_id, 'admin')) with check (public.has_role(tenant_id, 'admin'));
create policy members_delete on public.tenant_members for delete to authenticated using (public.has_role(tenant_id, 'admin'));

-- Standard tenant tables: read for any member, write for member+ -------------
do $$
declare
  t text;
begin
  foreach t in array array['data_sources','usage_items','permissions','site_services','applications',
                           'notices','notice_files','notice_instruments','actions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_role(tenant_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_role(tenant_id, ''member''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_role(tenant_id, ''member'')) with check (public.has_role(tenant_id, ''member''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_role(tenant_id, ''member''))', t || '_delete', t);
  end loop;
end $$;

-- Audit log: read-only for admins; rows are written by a security definer trigger
alter table public.audit_log enable row level security;
create policy audit_select on public.audit_log for select to authenticated using (public.has_role(tenant_id, 'admin'));

-- Anonymous users get nothing
revoke all on all tables in schema public from anon;
revoke execute on function public.create_tenant(text, text) from public, anon;
revoke execute on function public.create_actions_for_notice(uuid, integer) from public, anon;
revoke execute on function public.activate_source(uuid) from public, anon;
grant execute on function public.create_tenant(text, text) to authenticated;
grant execute on function public.create_actions_for_notice(uuid, integer) to authenticated;
grant execute on function public.activate_source(uuid) to authenticated;

-- ===== 20261103090300_storage.sql =====
-- Notice Desk: private storage buckets
-- Object paths must start with the tenant id: "<tenant_id>/<anything>".

insert into storage.buckets (id, name, public)
values ('source-files', 'source-files', false),
       ('notice-files', 'notice-files', false)
on conflict (id) do nothing;

create or replace function public.path_tenant(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

create policy notice_desk_files_select on storage.objects for select to authenticated
  using (bucket_id in ('source-files', 'notice-files') and public.has_role(public.path_tenant(name)));

create policy notice_desk_files_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('source-files', 'notice-files') and public.has_role(public.path_tenant(name), 'member'));

create policy notice_desk_files_update on storage.objects for update to authenticated
  using (bucket_id in ('source-files', 'notice-files') and public.has_role(public.path_tenant(name), 'member'));

create policy notice_desk_files_delete on storage.objects for delete to authenticated
  using (bucket_id in ('source-files', 'notice-files') and public.has_role(public.path_tenant(name), 'admin'));

-- ===== 20261103120000_change_summary.sql =====
-- Notice Desk: import the LSEG Quarterly Change Summary
-- Each summary row becomes a service change on a notice. Notices are created or
-- updated by Notification ID, so re-importing a newer summary refreshes them
-- without losing status, files or actions.

-- ---------------------------------------------------------------------------
-- Split a PDP / PE list ("IT1, IT2, ID2,WWBASEPRO") into a clean array,
-- keeping order and duplicates so old/new lists stay aligned by position.
-- ---------------------------------------------------------------------------
create or replace function public.split_codes(p text)
returns text[] language sql immutable parallel safe as $$
  select coalesce(array_agg(c order by ord), '{}')
    from unnest(regexp_split_to_array(
           btrim(regexp_replace(coalesce(p, ''), '[\s ,;]+', ',', 'g'), ','), ',')
         ) with ordinality as t(c, ord)
   where c <> ''
$$;

create or replace function public.distinct_codes(p text[])
returns text[] language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct c order by c), '{}') from unnest(p) c where c <> ''
$$;

-- ---------------------------------------------------------------------------
-- Extra notice fields carried by the summary
-- ---------------------------------------------------------------------------
alter table public.notices
  add column if not exists change_types         text[] not null default '{}',
  add column if not exists effective_to         date,
  add column if not exists published_date       date,
  add column if not exists revision_reason      text,
  add column if not exists affected_band        text,
  add column if not exists vendor_status        text,
  add column if not exists vendor_version       integer,
  add column if not exists associated_refs      text[] not null default '{}',
  add column if not exists associated_products  text,
  add column if not exists content_set          text,
  add column if not exists related_links        text,
  add column if not exists description          text,
  add column if not exists summary_import_id    uuid;

-- One row per summary line: old/new PDP, PE and price for a notice
create table public.notice_service_changes (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  notice_id   uuid not null,
  line_no     integer not null,
  old_pdp     text,
  new_pdp     text,
  old_pe      text,
  new_pe      text,
  old_price   text,
  new_price   text,
  old_pdps    text[] generated always as (public.split_codes(old_pdp)) stored,
  new_pdps    text[] generated always as (public.split_codes(new_pdp)) stored,
  foreign key (notice_id, tenant_id) references public.notices(id, tenant_id) on delete cascade
);
create index notice_service_changes_notice_idx on public.notice_service_changes(notice_id);
create index notice_service_changes_old_idx on public.notice_service_changes using gin (old_pdps);
create index notice_service_changes_new_idx on public.notice_service_changes using gin (new_pdps);

create table public.summary_imports (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  vendor           text not null default 'LSEG',
  file_name        text not null,
  storage_path     text,
  rows_read        integer not null default 0,
  notices_created  integer not null default 0,
  notices_updated  integer not null default 0,
  imported_by      uuid references auth.users(id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now()
);

alter table public.notice_service_changes enable row level security;
alter table public.summary_imports enable row level security;
do $$
declare t text;
begin
  foreach t in array array['notice_service_changes', 'summary_imports'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.has_role(tenant_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_role(tenant_id, ''member''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_role(tenant_id, ''member'')) with check (public.has_role(tenant_id, ''member''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_role(tenant_id, ''member''))', t || '_delete', t);
  end loop;
end $$;
revoke all on public.notice_service_changes, public.summary_imports from anon;

-- ---------------------------------------------------------------------------
-- PDP impact: which permissioned logins hold a code a notice changes.
--   side = 'old'  : code is being moved away from / removed
--          'new'  : code is being added
--          'both' : code appears on both sides
-- ---------------------------------------------------------------------------
create or replace view public.notice_pdp_codes with (security_invoker = true) as
select c.tenant_id, c.notice_id, code,
       case when bool_or(side = 'old') and bool_or(side = 'new') then 'both'
            when bool_or(side = 'old') then 'old' else 'new' end as side,
       min(c.old_price) filter (where side = 'old') as old_price,
       min(c.new_price) filter (where side = 'old') as new_price
  from public.notice_service_changes c
  cross join lateral (
    select unnest(c.old_pdps) as code, 'old' as side
    union all
    select unnest(c.new_pdps), 'new'
  ) x
 group by c.tenant_id, c.notice_id, code;

create or replace view public.notice_pdp_matches with (security_invoker = true) as
select pc.tenant_id, pc.notice_id, pc.code, pc.side, pc.old_price, pc.new_price,
       p.login, p.user_name, p.email, p.fee_structure
  from public.notice_pdp_codes pc
  join public.permissions p on p.tenant_id = pc.tenant_id and p.service_code = pc.code
  join public.data_sources s on s.id = p.source_id and s.is_current;

-- Exchange-level matching now reads both the codes typed on the notice and the
-- PDPs from imported service changes.
create or replace view public.notice_permission_matches with (security_invoker = true) as
select n.tenant_id, n.id as notice_id, p.login, p.user_name, p.email,
       p.service_code, p.fee_structure
  from public.notices n
  join public.permissions p on p.tenant_id = n.tenant_id
   and (p.service_code = any(n.service_codes)
        or exists (select 1 from public.notice_service_changes c
                    where c.notice_id = n.id
                      and (p.service_code = any(c.old_pdps) or p.service_code = any(c.new_pdps))))
  join public.data_sources s on s.id = p.source_id and s.is_current;

-- notice_impact gains change types, the affected band and the PDP codes you hold that the notice touches
create or replace view public.notice_impact with (security_invoker = true) as
select n.tenant_id, n.id as notice_id, n.ref, n.vendor, n.title, n.kind, n.status,
       n.effective_date, n.effective_date - current_date as days_to_effective,
       (select f.id from public.notice_files f where f.notice_id = n.id and f.is_current) as current_file_id,
       (select count(*) from public.notice_instruments ni
          join public.notice_files f on f.id = ni.file_id and f.is_current
         where ni.notice_id = n.id) as instruments,
       (select count(distinct m.instrument_id) from public.notice_instrument_matches m
         where m.notice_id = n.id and m.match_type = 'direct') as used_direct,
       (select count(distinct m.instrument_id) from public.notice_instrument_matches m
         where m.notice_id = n.id
           and not exists (select 1 from public.notice_instrument_matches d
                            where d.instrument_id = m.instrument_id and d.match_type = 'direct')) as used_via_chain,
       (select count(distinct m.login) from public.notice_instrument_matches m where m.notice_id = n.id) as logins_affected,
       (select count(distinct m.cost_centre) from public.notice_instrument_matches m where m.notice_id = n.id) as cost_centres,
       (select count(distinct pm.login) from public.notice_permission_matches pm where pm.notice_id = n.id) as logins_permissioned,
       (select count(*) from public.actions a where a.notice_id = n.id and a.status <> 'done') as open_actions,
       -- added by the change summary migration (new columns must go last)
       n.change_types, n.affected_band,
       (select coalesce(array_agg(distinct pm.code order by pm.code), '{}') from public.notice_pdp_matches pm where pm.notice_id = n.id) as your_pdps
  from public.notices n;

-- ---------------------------------------------------------------------------
-- import_change_summary(tenant, file_name, rows)
-- rows: JSON array of objects with keys
--   notification_id, title, change_type, effective_from, effective_to, summary,
--   description, published_date, revision_reason, affected_band, old_pdp,
--   new_pdp, old_price, new_price, old_pe, new_pe, status, version,
--   associated_ids, associated_products, content_set, related_links
-- Dates are 'YYYY-MM-DD' strings (or empty). Runs as the caller (RLS applies).
-- ---------------------------------------------------------------------------
create or replace function public.import_change_summary(
  p_tenant_id uuid, p_file_name text, p_rows jsonb, p_storage_path text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_import uuid;
  v_created integer := 0;
  v_updated integer := 0;
  r record;
  v_notice uuid;
  v_inserted boolean;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No rows to import';
  end if;

  insert into public.summary_imports(tenant_id, file_name, storage_path, rows_read)
  values (p_tenant_id, p_file_name, p_storage_path, jsonb_array_length(p_rows))
  returning id into v_import;

  for r in
    with rows as (
      select e, ord from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
       where coalesce(e->>'notification_id', '') <> ''
    ),
    firsts as (
      -- notice-level fields come from the first row for each notification
      select distinct on (e->>'notification_id') e->>'notification_id' as ref, e
        from rows order by e->>'notification_id', ord
    )
    select f.ref, f.e,
           (select jsonb_agg(x.e order by x.ord) from rows x where x.e->>'notification_id' = f.ref) as lines
      from firsts f
  loop
    insert into public.notices as n (
      tenant_id, ref, vendor, source, title, change_type, change_types, kind,
      effective_date, effective_to, published_date, revision_reason, affected_band,
      vendor_status, vendor_version, associated_refs, associated_products, content_set,
      related_links, summary, description, requires_file, status, summary_import_id)
    values (
      p_tenant_id, r.ref, 'LSEG', 'LSEG Quarterly Change Summary',
      coalesce(nullif(r.e->>'title', ''), r.ref),
      split_part(coalesce(r.e->>'change_type', ''), ',', 1),
      array(select btrim(x) from unnest(string_to_array(coalesce(r.e->>'change_type', ''), ',')) x where btrim(x) <> ''),
      'exchange',
      nullif(r.e->>'effective_from', '')::date,
      nullif(r.e->>'effective_to', '')::date,
      nullif(r.e->>'published_date', '')::date,
      nullif(r.e->>'revision_reason', ''),
      nullif(r.e->>'affected_band', ''),
      nullif(r.e->>'status', ''),
      nullif(regexp_replace(coalesce(r.e->>'version', ''), '\D', '', 'g'), '')::integer,
      public.distinct_codes(public.split_codes(r.e->>'associated_ids')),
      nullif(r.e->>'associated_products', ''),
      nullif(r.e->>'content_set', ''),
      nullif(r.e->>'related_links', ''),
      nullif(r.e->>'summary', ''),
      nullif(r.e->>'description', ''),
      false, 'new', v_import)
    on conflict (tenant_id, ref) do update set
      title = excluded.title, change_type = excluded.change_type, change_types = excluded.change_types,
      effective_date = excluded.effective_date, effective_to = excluded.effective_to,
      published_date = excluded.published_date, revision_reason = excluded.revision_reason,
      affected_band = excluded.affected_band, vendor_status = excluded.vendor_status,
      vendor_version = excluded.vendor_version, associated_refs = excluded.associated_refs,
      associated_products = excluded.associated_products, content_set = excluded.content_set,
      related_links = excluded.related_links, summary = excluded.summary,
      description = excluded.description, summary_import_id = excluded.summary_import_id
      -- status, kind, requires_file, files and actions are left as they are
    returning n.id, (xmax = 0) into v_notice, v_inserted;

    if v_inserted then v_created := v_created + 1; else v_updated := v_updated + 1; end if;

    delete from public.notice_service_changes where notice_id = v_notice;
    insert into public.notice_service_changes(tenant_id, notice_id, line_no, old_pdp, new_pdp, old_pe, new_pe, old_price, new_price)
    select p_tenant_id, v_notice, l.ord::integer,
           nullif(l.e->>'old_pdp', ''), nullif(l.e->>'new_pdp', ''),
           nullif(l.e->>'old_pe', ''), nullif(l.e->>'new_pe', ''),
           nullif(l.e->>'old_price', ''), nullif(l.e->>'new_price', '')
      from jsonb_array_elements(r.lines) with ordinality as l(e, ord);
  end loop;

  update public.summary_imports set notices_created = v_created, notices_updated = v_updated where id = v_import;
  return jsonb_build_object('import_id', v_import, 'rows', jsonb_array_length(p_rows),
                            'notices_created', v_created, 'notices_updated', v_updated);
end $$;

revoke execute on function public.import_change_summary(uuid, text, jsonb, text) from public, anon;
grant execute on function public.import_change_summary(uuid, text, jsonb, text) to authenticated;

-- ===== Demo workspace =====
-- Demo workspace generated by scripts/build-seed.mjs. Invented people and emails.
insert into public.tenants(id, name, slug) values ('00000000-0000-4000-8000-000000000001', 'Northgate Bank (demo)', 'northgate-demo') on conflict do nothing;
insert into public.data_sources(id, tenant_id, kind, file_name, report_version, generated_label, period_label, row_count, is_current) values
 ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'lseg_usage', 'Sample usage (pseudonymised from small_fake_usage_LSEG_Q2.csv)', 'dacs7.11.0.F1', '03/03/2025 15:02', '01 Feb 2025 – 28 Feb 2025', 126, true),
 ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000001', 'lseg_permissions', 'Sample permissions (pseudonymised from Latest Permission file 040326.csv)', 'dacs8.1.0.F1', '03/03/2026 09:40', null, 44, true),
 ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-000000000001', 'bpipe_usage', 'Sample B-PIPE usage', null, '01/11/2026', 'Oct 2026', 14, true);
insert into public.usage_items(tenant_id, source_id, vendor, login, user_name, user_group, cost_centre, email, service_code, service_desc, item) values
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','SHICNY3M=HKSH'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','SHICNY3M=HKSH'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','.TFTFSTHLP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','ALSO15=CTIP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','ALSO15=CTIP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','USDNOK.LMX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','0#AULc2=DLZ'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','0#AULc2=DLZ'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','3#EUR1=JSPN'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','/XS3056980751=VI'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','/XS3056980751=VI'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','KRTSY30Y=KQ'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','RENO3DNDH24Q4=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','CN022210010CR=CDCT'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','/NSBLYZ27-MABYZ27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','/ZAG000106980Y=JT'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','/WEA00554000L6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','/WEA00738000C6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','/ANHQZ5-M6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','TLIT15YZAAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','TLIT15YZAAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','0#ITEXO7Y40T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CME','CME','0#ITEXO7Y40T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CME','CME','SUC67600O7'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CME','CME','SUC67600O7'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','/XS2608963182=VI'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','/XS2608963182=VI'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','ECH1028=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CME','CME','ECH1028=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','0#ITEEU10Y24T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CME','CME','0#ITEEU10Y24T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','/DSEL1D00001000C6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','JPB00187986=JSPN'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','JPB00187986=JSPN'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','nkaur','Kaur Nisha','BE07010-005','RSK',null,'CME','CME','.FTAXXS'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','AXFIAEEAH06Q3=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','FXSE2H06Q2=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CME','CME','FXSE2H06Q2=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','AXSE4POAH18Q3=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','SCSE4LT14=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CME','CME','SCSE4LT14=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','REFIADNH03Q4=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CME','CME','CN022300046CR=CDCT'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','/QSUGD00000100N6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','GPS2YGBAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','0#KOMSEUACMPBMK='),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','0#SCI10YUSAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','0#SCI10YUSAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','UPMA2YSEAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','HUWB6MUSAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','ITEEU3Y36B=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CME','CME','ITEEU3Y36B=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','ITEEU3Y36B=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','ITEEU5Y36A=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CME','CME','ITEEU5Y36A=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','CDXHY3Y37A=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CME','CME','CDXHY3Y37A=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','ITEXO5Y42C=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CME','CME','ITEXO5Y42C=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','ITEXO5Y42C=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','ENI3YGBAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','KONI15YUSAC=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','SIFI5YJPAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','SIFI5YJPAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','VOLV6MSEAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','DSGI4YUSAM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','HPQ30YUSAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','HPQ30YUSAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','HOPS1YEUAC=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CME','CME','0#RUKNJPSMMPBMK='),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CME','CME','0#MSCI10YUSAB=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CME','CME','0#MSCI10YUSAB=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','AZO4YEUAR=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CU2','EUREX ULTRA','AZO4YEUAR=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','BSCT7YEUSM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SUC73600O6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CU2','EUREX ULTRA','SUC73600O6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SNYamc5'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SSNDcm4'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SSINR9425K6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','PEO1033=BSP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','PEO1033=BSP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','OBC0828=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','OBC0828=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','0#SSINRF7'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','0#SUCHQ6-U6S1'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CU2','EUREX ULTRA','0#SUCHQ6-U6S1'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SUC69000O6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CU2','EUREX ULTRA','SUC69000O6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','PLO1962045=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','PLO1962045=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SINXHU6-V6S1'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SUC72000N6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CU2','EUREX ULTRA','SUC72000N6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','PL57800014=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','PL57800014=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','DEK0628=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','DEK0628=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','KRU0231=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','KRU0231=WA'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SHKU126200L6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','EUR0135=BSP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','EUR0135=BSP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','DB1YJPZM=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','LEN15YGBAX=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CU2','EUREX ULTRA','/COR00340000E6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','vmarc','Vidal Marco','BE07010-003','CMD',null,'CU2','EUREX ULTRA','FXGERWAV=NPX'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','FLGV7YUSAB=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','TEXA4YUSAB=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CU2','EUREX ULTRA','TEXA4YUSAB=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','0#GSCA10YUSAC=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SSYHZ7-M8S1'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SUC73000D6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CU2','EUREX ULTRA','SUC73000D6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','0#SUCFLX:'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','BE07010-APP','QNT',null,'CU2','EUREX ULTRA','0#SUCFLX:'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','okafd','Okafor Daniel','BE07010-002','RAT',null,'CU2','EUREX ULTRA','EUR1031=BSP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','courbes','Interest Rate Curves','BE07010-APP','RSK',null,'CU2','EUREX ULTRA','EUR1031=BSP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','sbrig','Schultz Brigitte','BE07010-004','EQD',null,'CU2','EUREX ULTRA','SHKU125800N6'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','0#CDXHY7Y45T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CU2','EUREX ULTRA','0#CDXHY7Y45T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','0#ITEEU10Y26T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CU2','EUREX ULTRA','0#ITEEU10Y26T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','hlena','Harper Lena','BE07010-001','CRD',null,'CU2','EUREX ULTRA','0#CDXHY3Y45T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','murex4_prd','Murex4 PRD Environment','BE07010-APP','ITM',null,'CU2','EUREX ULTRA','0#CDXHY3Y45T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','LSEG','tanwp','Tan Wei Ping','BE07010-001','CRD',null,'CU2','EUREX ULTRA','0#CDXHY3Y45T=MP'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','sbrig','Schultz Brigitte',null,'EQD','brigitte.schultz@northgate-demo.example','PW',null,'NGB2 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','sbrig','Schultz Brigitte',null,'EQD','brigitte.schultz@northgate-demo.example','PW',null,'NGB5 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','sbrig','Schultz Brigitte',null,'EQD','brigitte.schultz@northgate-demo.example','PW',null,'NGQ3 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','sbrig','Schultz Brigitte',null,'EQD','brigitte.schultz@northgate-demo.example','PW',null,'WIG20 Index'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','vmarc','Vidal Marco',null,'CMD','marco.vidal@northgate-demo.example','PW',null,'ngb7  pw equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','vmarc','Vidal Marco',null,'CMD','marco.vidal@northgate-demo.example','ICE',null,'CO1 Comdty'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','vmarc','Vidal Marco',null,'CMD','marco.vidal@northgate-demo.example','ICE',null,'TTFG1MON Index'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','nkaur','Kaur Nisha',null,'RSK','nisha.kaur@northgate-demo.example','PW',null,'NGB11 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','nkaur','Kaur Nisha',null,'RSK','nisha.kaur@northgate-demo.example','EUX',null,'SX5E Index'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','bpipe_eqd_pricer_prd','EQD Pricer PRD',null,'EQD','support@northgate-demo.example','PW',null,'NGB2 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','bpipe_eqd_pricer_prd','EQD Pricer PRD',null,'EQD','support@northgate-demo.example','PW',null,'NGB5 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','bpipe_eqd_pricer_prd','EQD Pricer PRD',null,'EQD','support@northgate-demo.example','PW',null,'NGB11 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','bpipe_eqd_pricer_prd','EQD Pricer PRD',null,'EQD','support@northgate-demo.example','PW',null,'NGQ8 PW Equity'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','Bloomberg','bpipe_eqd_pricer_prd','EQD Pricer PRD',null,'EQD','support@northgate-demo.example','PW',null,'WIG20 Index');
insert into public.permissions(tenant_id, source_id, login, user_name, email, service_code, service_desc, fee_structure, activated_label) values
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','hlena','Harper Lena','lena.harper@northgate-demo.example','EXALL','FREE EXCHANGE DATA FOR INDIVIDUAL USE (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','hlena','Harper Lena','lena.harper@northgate-demo.example','CME','CME','1ST','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','hlena','Harper Lena','lena.harper@northgate-demo.example','CU2','EUREX ULTRA','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','hlena','Harper Lena','lena.harper@northgate-demo.example','LIE','ICE FUTURES EUROPE - FINANCIALS','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','hlena','Harper Lena','lena.harper@northgate-demo.example','MSI','MSCI INC.','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','hlena','Harper Lena','lena.harper@northgate-demo.example','STX','DEUTSCHE BOERSE - STOXX INDICES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','tanwp','Tan Wei Ping','weiping.tan@northgate-demo.example','EXALL','FREE EXCHANGE DATA FOR INDIVIDUAL USE (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','tanwp','Tan Wei Ping','weiping.tan@northgate-demo.example','CME','CME','1ST','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','tanwp','Tan Wei Ping','weiping.tan@northgate-demo.example','CU2','EUREX ULTRA','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','tanwp','Tan Wei Ping','weiping.tan@northgate-demo.example','LIE','ICE FUTURES EUROPE - FINANCIALS','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','tanwp','Tan Wei Ping','weiping.tan@northgate-demo.example','MSI','MSCI INC.','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','okafd','Okafor Daniel','daniel.okafor@northgate-demo.example','EXALL','FREE EXCHANGE DATA FOR INDIVIDUAL USE (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','okafd','Okafor Daniel','daniel.okafor@northgate-demo.example','CME','CME','1ST','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','okafd','Okafor Daniel','daniel.okafor@northgate-demo.example','LIE','ICE FUTURES EUROPE - FINANCIALS','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','okafd','Okafor Daniel','daniel.okafor@northgate-demo.example','ERX','EUREX REPO','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','okafd','Okafor Daniel','daniel.okafor@northgate-demo.example','SWR','SIX SWISS EXCHANGE REFERENCE RATES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','vmarc','Vidal Marco','marco.vidal@northgate-demo.example','EXALL','FREE EXCHANGE DATA FOR INDIVIDUAL USE (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','vmarc','Vidal Marco','marco.vidal@northgate-demo.example','CME','CME','1ST','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','vmarc','Vidal Marco','marco.vidal@northgate-demo.example','LIE','ICE FUTURES EUROPE - FINANCIALS','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','vmarc','Vidal Marco','marco.vidal@northgate-demo.example','NYS','NYSE LEVEL 1','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','sbrig','Schultz Brigitte','brigitte.schultz@northgate-demo.example','EXALL','FREE EXCHANGE DATA FOR INDIVIDUAL USE (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','sbrig','Schultz Brigitte','brigitte.schultz@northgate-demo.example','CU2','EUREX ULTRA','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','sbrig','Schultz Brigitte','brigitte.schultz@northgate-demo.example','GER','DEUTSCHE BOERSE XETRA ULTRA LEVEL 1','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','sbrig','Schultz Brigitte','brigitte.schultz@northgate-demo.example','STX','DEUTSCHE BOERSE - STOXX INDICES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','sbrig','Schultz Brigitte','brigitte.schultz@northgate-demo.example','DEF','DEUTSCHE BOERSE - DAX INDICES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','sbrig','Schultz Brigitte','brigitte.schultz@northgate-demo.example','OND','NASDAQ NORDIC DELAYED (DATAFEEDS ONLY)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','nkaur','Kaur Nisha','nisha.kaur@northgate-demo.example','EXALL','FREE EXCHANGE DATA FOR INDIVIDUAL USE (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','nkaur','Kaur Nisha','nisha.kaur@northgate-demo.example','MSI','MSCI INC.','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','nkaur','Kaur Nisha','nisha.kaur@northgate-demo.example','STX','DEUTSCHE BOERSE - STOXX INDICES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','nkaur','Kaur Nisha','nisha.kaur@northgate-demo.example','FSI','FTSE INTERNATIONAL LIMITED','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','nkaur','Kaur Nisha','nisha.kaur@northgate-demo.example','DEF','DEUTSCHE BOERSE - DAX INDICES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','murex4_prd','Murex4 PRD Environment','support@northgate-demo.example','EXALLNDU','FREE EXCHANGE DATA FOR NDU (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','murex4_prd','Murex4 PRD Environment','support@northgate-demo.example','CME','CME','1ST','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','murex4_prd','Murex4 PRD Environment','support@northgate-demo.example','CU2','EUREX ULTRA','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','murex4_uat','Murex4 UAT Environment','support@northgate-demo.example','EXALLNDU','FREE EXCHANGE DATA FOR NDU (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','support@northgate-demo.example','EXALLNDU','FREE EXCHANGE DATA FOR NDU (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','support@northgate-demo.example','CME','CME','1ST','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','support@northgate-demo.example','CU2','EUREX ULTRA','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','support@northgate-demo.example','OND','NASDAQ NORDIC DELAYED (DATAFEEDS ONLY)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','support@northgate-demo.example','CMN','CHICAGO MERCANTILE EXCHANGE (DELAYED DATAFEED)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','rtds_dss_streaming_qfeq_prd','DSSviaRTDS_PRODUCTION','support@northgate-demo.example','NAW','NASDAQ LEVEL 1 UTP DELAYED DATA(DATAFEED ONLY)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','courbes','Interest Rate Curves','support@northgate-demo.example','EXALLNDU','FREE EXCHANGE DATA FOR NDU (NOT REDIST)','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','courbes','Interest Rate Curves','support@northgate-demo.example','SWR','SIX SWISS EXCHANGE REFERENCE RATES','PKS','2023-04-27'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','courbes','Interest Rate Curves','support@northgate-demo.example','CEA','CBOE/CHICAGO BOARD OPTIONS','PKS','2023-04-27');
insert into public.applications(tenant_id, login, name, owner_team, owner_email) values
('00000000-0000-4000-8000-000000000001','murex4_prd','Murex (production)','Front Office Systems – Murex team','murex-support@northgate-demo.example'),
('00000000-0000-4000-8000-000000000001','murex4_uat','Murex (UAT)','Front Office Systems – Murex team','murex-support@northgate-demo.example'),
('00000000-0000-4000-8000-000000000001','rtds_dss_streaming_qfeq_prd','DSS via RTDS (production)','Quant Platform','quant-platform@northgate-demo.example'),
('00000000-0000-4000-8000-000000000001','courbes','Interest rate curves engine','Market Risk IT','risk-it@northgate-demo.example'),
('00000000-0000-4000-8000-000000000001','bpipe_eqd_pricer_prd','EQD pricer (production)','Equity Derivatives Technology','eqd-tech@northgate-demo.example');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000001','DN-26-1142','LSEG','LSEG Data Notification','Markit CDS index RICs: series roll and RIC renames','RIC change','ric','2026-11-20','2026-10-28',array[]::text[],true,'awaiting_file','https://portal.example/lseg/dn/26-1142','Markit CDS index RICs move to the new series on 20 Nov. Old-series RICs stop updating; new RICs are listed alongside. Applications that hard-code RICs (pricing, curves, risk) need updating before the effective date.');
insert into public.notice_files(id, tenant_id, notice_id, file_name, sheet_name, detected_columns, row_count) values
 ('00000000-0000-4000-8000-000000000200','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','DN_26_1142_affected_RICs.xlsx','Affected Instruments','{"instrument":"Current RIC","new_code":"New RIC","change":"Change Type","effective":"Effective Date"}'::jsonb,33);
insert into public.notice_instruments(tenant_id, notice_id, file_id, vendor, current_code, new_code, change_type, effective_label) values
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y36A=MP','ITEEU5Y44A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU3Y36B=MP','ITEEU3Y44B=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXHY3Y37A=MP','CDXHY3Y45A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO5Y42C=MP','ITEXO5Y44C=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU10Y24T=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXHY7Y45T=MP','CDXHY7Y46T=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','TLIT15YZAAM=MP','TLIT15YZAAN=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y30A=MP','ITEEU5Y40A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y31A=MP','ITEEU5Y41A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y32A=MP','ITEEU5Y42A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y33A=MP','ITEEU5Y43A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y34A=MP','ITEEU5Y44A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEEU5Y35A=MP','ITEEU5Y45A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y31A=MP','CDXIG5Y41A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y32A=MP','CDXIG5Y42A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y33A=MP','CDXIG5Y43A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y34A=MP','CDXIG5Y44A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y35A=MP','CDXIG5Y45A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y36A=MP','CDXIG5Y46A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y37A=MP','CDXIG5Y47A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','CDXIG5Y38A=MP','CDXIG5Y48A=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO3Y32C=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO3Y33C=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO3Y34C=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO3Y35C=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO3Y36C=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITEXO3Y37C=MP',null,'Discontinued','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITESNRF5Y10=MP','ITESNRF5Y11=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITESNRF5Y20=MP','ITESNRF5Y21=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITESNRF5Y30=MP','ITESNRF5Y31=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITESNRF5Y40=MP','ITESNRF5Y41=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITESNRF5Y50=MP','ITESNRF5Y51=MP','RIC rename','2026-11-20'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000200','LSEG','ITESNRF5Y60=MP','ITESNRF5Y61=MP','RIC rename','2026-11-20');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','DN-26-1157','LSEG','LSEG Data Notification','Nord Pool (=NPX) contract RICs discontinued','Discontinued','ric','2026-11-13','2026-10-30',array[]::text[],true,'awaiting_file','https://portal.example/lseg/dn/26-1157','A set of Nord Pool power contract RICs will no longer be published from 13 Nov. No replacement RICs are provided. Users should source alternatives or remove the RICs from watchlists and applications.');
insert into public.notice_files(id, tenant_id, notice_id, file_name, sheet_name, detected_columns, row_count) values
 ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','DN_26_1157_NPX_discontinued.xlsx','Affected Instruments','{"instrument":"Current RIC","new_code":"New RIC","change":"Change Type","effective":"Effective Date"}'::jsonb,19);
insert into public.notice_instruments(tenant_id, notice_id, file_id, vendor, current_code, new_code, change_type, effective_label) values
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','RENO3DNDH24Q4=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXFIAEEAH06Q3=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXSE2H06Q2=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','SCSE4LT14=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ125=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ225=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ325=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ425=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ525=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ625=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ725=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ825=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','AXDEBLQ925=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXNOR1H06=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXNOR2H06=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXNOR3H06=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXNOR4H06=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXNOR5H06=NPX',null,'Discontinued','2026-11-13'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','LSEG','FXNOR6H06=NPX',null,'Discontinued','2026-11-13');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','DN-26-1163','LSEG','LSEG Data Notification (Eurex)','Eurex: delisting of selected single stock options','Delisting','ric','2026-12-01','2026-11-02',array['CU2']::text[],true,'awaiting_file','https://portal.example/lseg/dn/26-1163','Eurex is delisting a group of single stock option series on 1 Dec. The affected RIC list is on the LSEG portal. Expect impact on users and apps permissioned for EUREX ULTRA (CU2).');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','EX-CME-26-41','CME Group','Exchange notice','Real-time market data fee changes from 1 January 2027','Fee change','exchange','2027-01-01','2026-10-15',array['CME']::text[],false,'new','https://portal.example/cme/notices/26-41','CME is changing its professional real-time display fees and non-display licence categories from 1 Jan 2027. No instrument changes. Impact is cost and licensing: review every login permissioned for CME before the budget cycle.');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000001','DN-26-1170','LSEG','LSEG Data Notification','Nasdaq Nordic delayed data: datafeed redistribution policy update','Policy','exchange','2027-02-01','2026-11-01',array['OND']::text[],false,'new','https://portal.example/lseg/dn/26-1170','Nasdaq Nordic is tightening its redistribution terms for delayed datafeed use. Applications that consume OND and pass data to other systems may need a new declaration.');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000001','BBG-26-118','Bloomberg','Bloomberg B-PIPE notice','B-PIPE: Warsaw equity ticker changes after index review','Ticker change','ticker','2026-11-24','2026-11-02',array[]::text[],true,'awaiting_file','https://portal.example/bbg/notices/118','Bloomberg is changing tickers for a set of Warsaw-listed equities on 24 Nov. The affected ticker list is available on the Bloomberg support portal.');
insert into public.notice_files(id, tenant_id, notice_id, file_name, sheet_name, detected_columns, row_count) values
 ('00000000-0000-4000-8000-000000000205','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','BBG_118_ticker_changes.xlsx','Affected Instruments','{"instrument":"Current Ticker","new_code":"New Ticker","change":"Change Type","effective":"Effective Date"}'::jsonb,12);
insert into public.notice_instruments(tenant_id, notice_id, file_id, vendor, current_code, new_code, change_type, effective_label) values
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB1 PW Equity','NGX1 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB2 PW Equity','NGX2 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB3 PW Equity','NGX3 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB4 PW Equity','NGX4 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB5 PW Equity','NGX5 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB6 PW Equity','NGX6 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB7 PW Equity','NGX7 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB8 PW Equity','NGX8 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB9 PW Equity','NGX9 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB10 PW Equity','NGX10 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB11 PW Equity','NGX11 PW Equity','Ticker change','2026-11-24'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000205','Bloomberg','NGB12 PW Equity','NGX12 PW Equity','Ticker change','2026-11-24');
insert into public.notices(id, tenant_id, ref, vendor, source, title, change_type, kind, effective_date, received_date, service_codes, requires_file, status, portal_url, summary) values
 ('00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000001','DN-26-1129','LSEG','LSEG Data Notification','Warsaw bond (=WA) RIC restructure','RIC change','ric','2026-11-10','2026-10-20',array[]::text[],true,'awaiting_file','https://portal.example/lseg/dn/26-1129','Warsaw-listed government and corporate bond RICs gain a new suffix (=WAR) on 10 Nov. Old RICs are retired on the same day.');
insert into public.notice_files(id, tenant_id, notice_id, file_name, sheet_name, detected_columns, row_count) values
 ('00000000-0000-4000-8000-000000000206','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','DN_26_1129_WA_restructure.xlsx','Affected Instruments','{"instrument":"Current RIC","new_code":"New RIC","change":"Change Type","effective":"Effective Date"}'::jsonb,14);
insert into public.notice_instruments(tenant_id, notice_id, file_id, vendor, current_code, new_code, change_type, effective_label) values
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','KRU0231=WA','KRU0231=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','DEK0628=WA','DEK0628=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PL57800014=WA','PL57800014=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','OBC0828=WA','OBC0828=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','ECH1028=WA','ECH1028=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PLO1962045=WA','PLO1962045=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0129=WA','PS0129=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0229=WA','PS0229=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0329=WA','PS0329=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0429=WA','PS0429=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0529=WA','PS0529=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0629=WA','PS0629=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0729=WA','PS0729=WAR','RIC rename','2026-11-10'),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000206','LSEG','PS0829=WA','PS0829=WAR','RIC rename','2026-11-10');
select public.create_actions_for_notice('00000000-0000-4000-8000-000000000100');
select public.create_actions_for_notice('00000000-0000-4000-8000-000000000106');
update public.actions set status = 'done' where notice_id = '00000000-0000-4000-8000-000000000106';
update public.actions set status = 'done' where id = (select id from public.actions where notice_id = '00000000-0000-4000-8000-000000000100' order by number limit 1);
update public.actions set status = 'in_progress' where id = (select id from public.actions where notice_id = '00000000-0000-4000-8000-000000000100' order by number offset 1 limit 1);

-- ===== Give yourself admin access to the demo workspace (edit the email) =====
insert into public.tenant_members (tenant_id, user_id, role)
select '00000000-0000-4000-8000-000000000001', id, 'admin'
from auth.users where email = 'your.email@example.com'
on conflict do nothing;
