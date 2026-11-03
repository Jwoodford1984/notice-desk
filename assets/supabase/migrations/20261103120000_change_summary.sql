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

-- ---------------------------------------------------------------------------
-- Actions for notices that are already effective (common when importing a
-- quarter's summary late) get a due date 3 days from today instead of a date
-- in the past.
-- ---------------------------------------------------------------------------
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
           greatest(v_notice.effective_date - p_days_before, current_date + 3)
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
