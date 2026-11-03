-- Notice Desk update 5: vendor price lists, for cost estimates in the impact report.
-- One row per vendor + PDP; each import replaces that vendor's list.

create table public.lib_prices (
  vendor             text not null check (vendor in ('LSEG', 'Bloomberg')),
  pdp                text not null,
  quarter            text,
  exchange_name      text,
  service_name       text,
  billed_by          text,
  country_exceptions text,
  comments           text,
  user_charge        numeric,
  currency           text,
  site_licence       numeric,
  price_usd          numeric,
  price_eur          numeric,
  price_gbp          numeric,
  dn                 text,
  source             text,
  updated_at         timestamptz not null default now(),
  primary key (vendor, pdp)
);
alter table public.lib_prices enable row level security;
create policy lib_prices_read on public.lib_prices for select to authenticated using ((select public.can_use_library()));
create policy lib_prices_insert on public.lib_prices for insert to authenticated with check ((select public.is_cjc_admin()));
create policy lib_prices_update on public.lib_prices for update to authenticated using ((select public.is_cjc_admin())) with check ((select public.is_cjc_admin()));
create policy lib_prices_delete on public.lib_prices for delete to authenticated using ((select public.is_cjc_admin()));
revoke all on public.lib_prices from anon;

create or replace function public.lib_import_prices(p_vendor text, p_quarter text, p_rows jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can change the library'; end if;
  delete from public.lib_prices where vendor = p_vendor;
  insert into public.lib_prices (vendor, pdp, quarter, exchange_name, service_name, billed_by, country_exceptions, comments,
    user_charge, currency, site_licence, price_usd, price_eur, price_gbp, dn, source)
  select p_vendor, e->>'pdp', p_quarter, nullif(e->>'exchange_name', ''), nullif(e->>'service_name', ''), nullif(e->>'billed_by', ''),
         nullif(e->>'country_exceptions', ''), nullif(e->>'comments', ''), (e->>'user_charge')::numeric, nullif(e->>'currency', ''),
         (e->>'site_licence')::numeric, (e->>'price_usd')::numeric, (e->>'price_eur')::numeric, (e->>'price_gbp')::numeric,
         nullif(e->>'dn', ''), nullif(e->>'source', '')
    from jsonb_array_elements(p_rows) e
   where coalesce(e->>'pdp', '') <> ''
  on conflict (vendor, pdp) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.lib_import_prices(text, text, jsonb) from public, anon;
grant execute on function public.lib_import_prices(text, text, jsonb) to authenticated;
