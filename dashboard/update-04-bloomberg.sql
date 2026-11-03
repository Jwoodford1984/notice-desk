-- Notice Desk update 4: Bloomberg notices (action required, EIDs)
-- Run once in Dashboard -> SQL Editor, after update-03.

-- Notice Desk update 4: Bloomberg notices
-- * lib_notices.action_required holds Bloomberg's "Action Required" heading
--   (Expense Management, Subscription Review, Data Review, ...).
-- * For Bloomberg notices, lib_service_changes.old_pdp / new_pdp hold EIDs and
--   old_pe / new_pe hold the EID names.

alter table public.lib_notices add column if not exists action_required text;

create or replace function public.lib_import_summary(p_vendor text, p_quarter text, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r record; v_id bigint; v_ins boolean; v_created int := 0; v_updated int := 0;
begin
  if not public.is_cjc_admin() then raise exception 'Only CJC IT admins can change the library'; end if;
  for r in
    with rows as (select e, ord from jsonb_array_elements(p_rows) with ordinality t(e, ord)
                   where coalesce(e->>'notification_id', '') <> '' and e->>'notification_id' !~ '\s'),
    firsts as (select distinct on (e->>'notification_id') e->>'notification_id' as ref, e from rows order by e->>'notification_id', ord)
    select f.ref, f.e, (select jsonb_agg(x.e order by x.ord) from rows x where x.e->>'notification_id' = f.ref) as lines from firsts f
  loop
    insert into public.lib_notices as n (vendor, ref, title, quarter, change_types, effective_date, effective_to, published_date,
      revision_reason, affected_band, vendor_status, vendor_version, associated_refs, content_set, related_links, summary, description, action_required)
    values (p_vendor, r.ref, coalesce(nullif(r.e->>'title', ''), r.ref), p_quarter,
      array(select btrim(x) from unnest(string_to_array(coalesce(r.e->>'change_type', ''), ',')) x where btrim(x) <> ''),
      nullif(r.e->>'effective_from', '')::date, nullif(r.e->>'effective_to', '')::date, nullif(r.e->>'published_date', '')::date,
      nullif(r.e->>'revision_reason', ''), nullif(r.e->>'affected_band', ''), nullif(r.e->>'status', ''),
      nullif(regexp_replace(coalesce(r.e->>'version', ''), '\D', '', 'g'), '')::integer,
      public.distinct_codes(public.split_codes(r.e->>'associated_ids')), nullif(r.e->>'content_set', ''),
      nullif(r.e->>'related_links', ''), nullif(r.e->>'summary', ''), nullif(r.e->>'description', ''), nullif(r.e->>'action_required', ''))
    on conflict (vendor, ref) do update set
      title = excluded.title, quarter = coalesce(excluded.quarter, n.quarter), change_types = excluded.change_types,
      effective_date = excluded.effective_date, effective_to = excluded.effective_to, published_date = excluded.published_date,
      revision_reason = excluded.revision_reason, affected_band = excluded.affected_band, vendor_status = excluded.vendor_status,
      vendor_version = excluded.vendor_version, associated_refs = excluded.associated_refs, content_set = excluded.content_set,
      related_links = excluded.related_links, summary = excluded.summary, description = excluded.description,
      action_required = excluded.action_required
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
