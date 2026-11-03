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
