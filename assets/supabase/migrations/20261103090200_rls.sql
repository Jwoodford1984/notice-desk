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
