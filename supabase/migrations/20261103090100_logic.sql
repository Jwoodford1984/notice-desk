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
