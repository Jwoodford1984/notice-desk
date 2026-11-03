-- Notice Desk update 3: shared notice library, CJC admin role, client administration
-- Run once in Dashboard -> SQL Editor, after update-02.

-- Notice Desk update 3: shared notice library
--
-- CJC IT maintains one library of vendor notices (from the Quarterly Change
-- Summary) and their affected RIC / ticker lists. Clients sign in and check
-- their DACS files against it. Client DACS data is read in the browser and is
-- never stored: only RIC and PDP codes are sent here for matching.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create table public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
create policy app_admins_self on public.app_admins for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_cjc_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()))
$$;

-- Library readers: CJC admins and anyone who belongs to a client workspace
create or replace function public.can_use_library()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()))
      or exists (select 1 from public.tenant_members where user_id = (select auth.uid()))
$$;

-- ---------------------------------------------------------------------------
-- Library tables
-- ---------------------------------------------------------------------------
create table public.lib_notices (
  id              bigint generated always as identity primary key,
  vendor          text not null check (vendor in ('LSEG', 'Bloomberg')),
  ref             text not null,
  title           text not null,
  quarter         text,
  change_types    text[] not null default '{}',
  effective_date  date,
  effective_to    date,
  published_date  date,
  revision_reason text,
  affected_band   text,
  vendor_status   text,
  vendor_version  integer,
  associated_refs text[] not null default '{}',
  content_set     text,
  related_links   text,
  summary         text,
  description     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vendor, ref)
);
create trigger lib_notices_updated_at before update on public.lib_notices for each row execute function public.set_updated_at();

create table public.lib_service_changes (
  id        bigint generated always as identity primary key,
  notice_id bigint not null references public.lib_notices(id) on delete cascade,
  line_no   integer not null,
  old_pdp   text, new_pdp text, old_pe text, new_pe text, old_price text, new_price text,
  old_pdps  text[] generated always as (public.split_codes(old_pdp)) stored,
  new_pdps  text[] generated always as (public.split_codes(new_pdp)) stored
);
create index lib_service_changes_notice_idx on public.lib_service_changes(notice_id);

create table public.lib_files (
  id          bigint generated always as identity primary key,
  notice_id   bigint not null references public.lib_notices(id) on delete cascade,
  file_name   text not null,
  status      text not null default 'loading' check (status in ('loading', 'ready')),
  is_current  boolean not null default false,
  total_rows  integer not null default 0,
  stored_rows integer not null default 0,
  sheets      jsonb not null default '[]'::jsonb,
  columns     jsonb not null default '{}'::jsonb,
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
create unique index lib_files_one_current on public.lib_files(notice_id) where is_current;

-- PDP / PE lists repeat across hundreds of thousands of rows, so each file
-- stores its distinct combinations once and rows point at them.
create table public.lib_pdp_sets (
  id       bigint generated always as identity primary key,
  file_id  bigint not null references public.lib_files(id) on delete cascade,
  idx      integer not null,
  old_pdp  text, new_pdp text, old_pe text, new_pe text,
  unique (file_id, idx)
);

-- One row per affected instrument (about 1.5 million for an LSEG quarter).
create table public.lib_instruments (
  file_id       bigint not null references public.lib_files(id) on delete cascade,
  code          text not null,
  new_code      text,
  change_type   text,
  set_id        bigint references public.lib_pdp_sets(id) on delete cascade,
  ric_name      text,
  exchange_code text
);
create index lib_instruments_code_idx on public.lib_instruments(code);
create index lib_instruments_file_idx on public.lib_instruments(file_id);

-- ---------------------------------------------------------------------------
-- Row level security: everyone with access reads, only CJC admins write
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['lib_notices', 'lib_service_changes', 'lib_files', 'lib_pdp_sets', 'lib_instruments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.can_use_library()))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_cjc_admin()))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.is_cjc_admin())) with check ((select public.is_cjc_admin()))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_cjc_admin()))', t || '_delete', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Library loading (run as the caller, so only admins succeed)
-- ---------------------------------------------------------------------------

-- Create or update notices from a Quarterly Change Summary (rows as produced
-- by parseChangeSummary). Service changes are replaced; files are kept.
create or replace function public.lib_import_summary(p_vendor text, p_quarter text, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r record; v_id bigint; v_ins boolean; v_created int := 0; v_updated int := 0;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can change the library'; end if;
  for r in
    with rows as (select e, ord from jsonb_array_elements(p_rows) with ordinality t(e, ord) where coalesce(e->>'notification_id', '') <> ''),
    firsts as (select distinct on (e->>'notification_id') e->>'notification_id' as ref, e from rows order by e->>'notification_id', ord)
    select f.ref, f.e, (select jsonb_agg(x.e order by x.ord) from rows x where x.e->>'notification_id' = f.ref) as lines from firsts f
  loop
    insert into public.lib_notices as n (vendor, ref, title, quarter, change_types, effective_date, effective_to, published_date,
      revision_reason, affected_band, vendor_status, vendor_version, associated_refs, content_set, related_links, summary, description)
    values (p_vendor, r.ref, coalesce(nullif(r.e->>'title', ''), r.ref), p_quarter,
      array(select btrim(x) from unnest(string_to_array(coalesce(r.e->>'change_type', ''), ',')) x where btrim(x) <> ''),
      nullif(r.e->>'effective_from', '')::date, nullif(r.e->>'effective_to', '')::date, nullif(r.e->>'published_date', '')::date,
      nullif(r.e->>'revision_reason', ''), nullif(r.e->>'affected_band', ''), nullif(r.e->>'status', ''),
      nullif(regexp_replace(coalesce(r.e->>'version', ''), '\D', '', 'g'), '')::integer,
      public.distinct_codes(public.split_codes(r.e->>'associated_ids')), nullif(r.e->>'content_set', ''),
      nullif(r.e->>'related_links', ''), nullif(r.e->>'summary', ''), nullif(r.e->>'description', ''))
    on conflict (vendor, ref) do update set
      title = excluded.title, quarter = coalesce(excluded.quarter, n.quarter), change_types = excluded.change_types,
      effective_date = excluded.effective_date, effective_to = excluded.effective_to, published_date = excluded.published_date,
      revision_reason = excluded.revision_reason, affected_band = excluded.affected_band, vendor_status = excluded.vendor_status,
      vendor_version = excluded.vendor_version, associated_refs = excluded.associated_refs, content_set = excluded.content_set,
      related_links = excluded.related_links, summary = excluded.summary, description = excluded.description
    returning n.id, (xmax = 0) into v_id, v_ins;
    if v_ins then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
    delete from public.lib_service_changes where notice_id = v_id;
    insert into public.lib_service_changes(notice_id, line_no, old_pdp, new_pdp, old_pe, new_pe, old_price, new_price)
    select v_id, l.ord::int, nullif(l.e->>'old_pdp', ''), nullif(l.e->>'new_pdp', ''), nullif(l.e->>'old_pe', ''),
           nullif(l.e->>'new_pe', ''), nullif(l.e->>'old_price', ''), nullif(l.e->>'new_price', '')
      from jsonb_array_elements(r.lines) with ordinality l(e, ord);
  end loop;
  return jsonb_build_object('notices_created', v_created, 'notices_updated', v_updated);
end $$;

-- Start loading a notice spreadsheet. Creates a placeholder notice if the
-- summary hasn't been imported yet. Returns the new file id.
create or replace function public.lib_begin_file(p_vendor text, p_ref text, p_file_name text,
  p_total integer, p_sheets jsonb, p_columns jsonb, p_quarter text default null)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_notice bigint; v_file bigint;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can change the library'; end if;
  insert into public.lib_notices(vendor, ref, title, quarter) values (p_vendor, p_ref, p_ref, p_quarter)
  on conflict (vendor, ref) do update set quarter = coalesce(public.lib_notices.quarter, excluded.quarter)
  returning id into v_notice;
  insert into public.lib_files(notice_id, file_name, total_rows, sheets, columns)
  values (v_notice, p_file_name, p_total, coalesce(p_sheets, '[]'::jsonb), coalesce(p_columns, '{}'::jsonb))
  returning id into v_file;
  return v_file;
end $$;

-- p_sets: [[old_pdp, new_pdp, old_pe, new_pe], ...] numbered p_offset + 1, p_offset + 2, ...
create or replace function public.lib_add_sets(p_file_id bigint, p_sets jsonb, p_offset integer default 0)
returns integer language sql security invoker set search_path = '' as $$
  with ins as (
    insert into public.lib_pdp_sets(file_id, idx, old_pdp, new_pdp, old_pe, new_pe)
    select p_file_id, p_offset + ord::int, nullif(e->>0, ''), nullif(e->>1, ''), nullif(e->>2, ''), nullif(e->>3, '')
      from jsonb_array_elements(p_sets) with ordinality t(e, ord)
    returning 1)
  select count(*)::int from ins
$$;

-- p_rows: [[code, new_code, change_type, set_idx, ric_name, exchange_code], ...]
create or replace function public.lib_add_rows(p_file_id bigint, p_rows jsonb)
returns integer language sql security invoker set search_path = '' as $$
  with ins as (
    insert into public.lib_instruments(file_id, code, new_code, change_type, set_id, ric_name, exchange_code)
    select p_file_id, e->>0, nullif(e->>1, ''), nullif(e->>2, ''), s.id, nullif(e->>4, ''), nullif(e->>5, '')
      from jsonb_array_elements(p_rows) e
      left join public.lib_pdp_sets s on s.file_id = p_file_id and s.idx = nullif(e->>3, '')::int
    returning 1)
  select count(*)::int from ins
$$;

-- Make a fully loaded file the current one for its notice
create or replace function public.lib_finish_file(p_file_id bigint)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_notice bigint;
begin
  select notice_id into v_notice from public.lib_files where id = p_file_id;
  update public.lib_files set is_current = false where notice_id = v_notice and is_current and id <> p_file_id;
  update public.lib_files set is_current = true, status = 'ready',
         stored_rows = (select count(*) from public.lib_instruments where file_id = p_file_id)
   where id = p_file_id;
end $$;

-- Delete rows of replaced or abandoned files a chunk at a time (stays inside
-- the API's statement time limit). Call until it returns 0.
create or replace function public.lib_purge(p_limit integer default 50000)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_deleted integer;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can change the library'; end if;
  with doomed as (
    select i.ctid from public.lib_instruments i join public.lib_files f on f.id = i.file_id
     where not f.is_current and (f.status = 'ready' or f.created_at < now() - interval '1 hour')
     limit p_limit)
  delete from public.lib_instruments where ctid in (select ctid from doomed);
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    delete from public.lib_files f where not f.is_current and (f.status = 'ready' or f.created_at < now() - interval '1 hour')
       and not exists (select 1 from public.lib_instruments i where i.file_id = f.id);
  end if;
  return v_deleted;
end $$;

-- ---------------------------------------------------------------------------
-- Matching (client side sends codes only)
-- ---------------------------------------------------------------------------
create or replace function public.lib_match_codes(p_vendor text, p_codes text[])
returns table (code text, notice_id bigint, ref text, new_code text, change_type text, ric_name text,
               exchange_code text, old_pdp text, new_pdp text, old_pe text, new_pe text)
language sql stable security invoker set search_path = '' as $$
  select i.code, n.id, n.ref, i.new_code, i.change_type, i.ric_name, i.exchange_code, s.old_pdp, s.new_pdp, s.old_pe, s.new_pe
    from (select distinct unnest(p_codes) as code) c
    join public.lib_instruments i on i.code = c.code
    join public.lib_files f on f.id = i.file_id and f.is_current
    join public.lib_notices n on n.id = f.notice_id and n.vendor = p_vendor
    left join public.lib_pdp_sets s on s.id = i.set_id
$$;

-- Library overview for the admin page
create or replace view public.lib_overview with (security_invoker = true) as
select n.id, n.vendor, n.ref, n.title, n.quarter, n.change_types, n.effective_date, n.affected_band,
       (select count(*) from public.lib_service_changes c where c.notice_id = n.id) as service_changes,
       f.id as file_id, f.file_name, f.total_rows, f.stored_rows, f.created_at as file_loaded_at,
       (select count(*) from public.lib_files l where l.notice_id = n.id and l.status = 'loading') as files_loading
  from public.lib_notices n
  left join public.lib_files f on f.notice_id = n.id and f.is_current;

-- ---------------------------------------------------------------------------
-- Client administration (CJC admins only)
-- ---------------------------------------------------------------------------
create or replace function public.admin_clients()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can manage clients'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug,
           'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role) order by u.email)
                                  from public.tenant_members m join auth.users u on u.id = m.user_id where m.tenant_id = t.id), '[]'::jsonb))
           order by t.name) from public.tenants t), '[]'::jsonb);
end $$;

create or replace function public.admin_create_client(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can manage clients'; end if;
  insert into public.tenants(name, slug) values (p_name, p_slug) returning id into v_id;
  return v_id;
end $$;

create or replace function public.admin_add_member(p_tenant_id uuid, p_email text, p_role public.member_role default 'member')
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can manage clients'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'There''s no account for % yet. Create it in Supabase (Authentication → Users → Add user), then add it here.', p_email;
  end if;
  insert into public.tenant_members(tenant_id, user_id, role) values (p_tenant_id, v_user, p_role)
  on conflict (tenant_id, user_id) do update set role = excluded.role;
end $$;

create or replace function public.admin_remove_member(p_tenant_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can manage clients'; end if;
  delete from public.tenant_members where tenant_id = p_tenant_id and user_id = p_user_id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['is_cjc_admin()', 'can_use_library()', 'lib_import_summary(text, text, jsonb)',
    'lib_begin_file(text, text, text, integer, jsonb, jsonb, text)', 'lib_add_sets(bigint, jsonb, integer)', 'lib_add_rows(bigint, jsonb)',
    'lib_finish_file(bigint)', 'lib_purge(integer)', 'lib_match_codes(text, text[])', 'admin_clients()',
    'admin_create_client(text, text)', 'admin_add_member(uuid, text, public.member_role)', 'admin_remove_member(uuid, uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Make Jack a CJC IT admin (edit the email for other admins)
insert into public.app_admins(user_id) select id from auth.users where email = 'your.email@example.com' on conflict do nothing;
