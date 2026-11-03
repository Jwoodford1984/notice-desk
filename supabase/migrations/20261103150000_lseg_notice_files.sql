-- Notice Desk update 2: LSEG Data Notification spreadsheets
-- * Instrument rows keep RIC name, old/new PDP and PE, exchange and source sheet.
-- * Large files are read in the browser and only instruments that appear in
--   usage are stored; the file row keeps the full row count.
-- * Each matched user/RIC gets an access check: does the login hold any of the
--   RIC's new PDPs?

alter table public.notice_instruments
  add column if not exists ric_name      text,
  add column if not exists old_pdp       text,
  add column if not exists new_pdp       text,
  add column if not exists old_pe        text,
  add column if not exists new_pe        text,
  add column if not exists exchange_code text,
  add column if not exists sheet         text;
alter table public.notice_instruments
  add column if not exists old_pdps text[] generated always as (public.split_codes(old_pdp)) stored,
  add column if not exists new_pdps text[] generated always as (public.split_codes(new_pdp)) stored;

alter table public.notice_files
  add column if not exists total_rows      integer,
  add column if not exists stored_rows     integer,
  add column if not exists matched_only    boolean not null default false,
  add column if not exists sheets          jsonb not null default '[]'::jsonb,
  add column if not exists usage_source_id uuid references public.data_sources(id) on delete set null;

-- Usage codes for the browser to filter large notice files against.
-- One JSON value, so it isn't cut off by the API's row limit.
create or replace function public.current_usage_codes(p_tenant_id uuid, p_vendor text default 'LSEG')
returns jsonb language sql stable security invoker set search_path = '' as $$
  with src as (
    select id from public.data_sources
     where tenant_id = p_tenant_id and is_current
       and kind = case when p_vendor = 'Bloomberg' then 'bpipe_usage'::public.source_kind else 'lseg_usage'::public.source_kind end
  )
  select jsonb_build_object(
    'source_id', (select id from src),
    'codes',  coalesce((select jsonb_agg(distinct u.item_norm) from public.usage_items u
                         where u.source_id = (select id from src)), '[]'::jsonb),
    'chains', coalesce((select jsonb_agg(distinct u.chain_base) from public.usage_items u
                         where u.source_id = (select id from src) and u.chain_base is not null), '[]'::jsonb))
$$;
revoke execute on function public.current_usage_codes(uuid, text) from public, anon;
grant execute on function public.current_usage_codes(uuid, text) to authenticated;

-- Matches gain RIC name, PDPs and an access check (new columns go last).
--   access = 'keeps'   the login is permissioned for at least one of the RIC's new PDPs
--            'loses'   the login has permissions on file but none of the new PDPs
--            'unknown' no new PDPs listed, or the login isn't in the permission file
create or replace view public.notice_instrument_matches with (security_invoker = true) as
select ni.tenant_id, ni.notice_id, ni.id as instrument_id,
       ni.current_code, ni.new_code, ni.change_type,
       u.login, u.user_name, u.cost_centre, u.service_code, u.item as used_item,
       case when u.item_norm = ni.code_norm then 'direct' else 'chain' end as match_type,
       ni.ric_name, ni.old_pdp, ni.new_pdp,
       case
         when cardinality(ni.new_pdps) = 0 then 'unknown'
         when exists (select 1 from public.permissions p join public.data_sources ps on ps.id = p.source_id and ps.is_current
                       where p.tenant_id = ni.tenant_id and p.login = u.login and p.service_code = any(ni.new_pdps)) then 'keeps'
         when exists (select 1 from public.permissions p join public.data_sources ps on ps.id = p.source_id and ps.is_current
                       where p.tenant_id = ni.tenant_id and p.login = u.login) then 'loses'
         else 'unknown'
       end as access
  from public.notice_instruments ni
  join public.notice_files f on f.id = ni.file_id and f.is_current
  join public.usage_items u
    on u.tenant_id = ni.tenant_id and u.vendor = ni.vendor
   and (u.item_norm = ni.code_norm or u.chain_base = ni.code_norm)
  join public.data_sources s on s.id = u.source_id and s.is_current;

-- Instrument count comes from the file's full row count when only matches were stored.
create or replace view public.notice_impact with (security_invoker = true) as
select n.tenant_id, n.id as notice_id, n.ref, n.vendor, n.title, n.kind, n.status,
       n.effective_date, n.effective_date - current_date as days_to_effective,
       (select f.id from public.notice_files f where f.notice_id = n.id and f.is_current) as current_file_id,
       coalesce((select f.total_rows from public.notice_files f where f.notice_id = n.id and f.is_current),
                (select count(*) from public.notice_instruments ni
                   join public.notice_files f on f.id = ni.file_id and f.is_current
                  where ni.notice_id = n.id)) as instruments,
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
       n.change_types, n.affected_band,
       (select coalesce(array_agg(distinct pm.code order by pm.code), '{}') from public.notice_pdp_matches pm where pm.notice_id = n.id) as your_pdps,
       -- added by update 2
       (select count(distinct m.login) from public.notice_instrument_matches m where m.notice_id = n.id and m.access = 'loses') as logins_losing_access
  from public.notices n;
