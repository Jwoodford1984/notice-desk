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
