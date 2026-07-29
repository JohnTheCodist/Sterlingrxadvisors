-- RxNaija Analytics — multi-tenant Postgres schema (Supabase)
--
-- Mirrors the star schema previously implemented in
-- server/services/database.js (better-sqlite3, single-tenant) plus the
-- four JSON-file stores (dataset-registry.json, fact-store.json,
-- pharmacy-profile.json, server/mappings/*.json), now organization-scoped
-- with Row-Level Security. See the migration plan for full context.
--
-- Isolation model: every tenant table carries organization_id. RLS is
-- defense-in-depth — the Express backend connects with the service_role
-- key (bypasses RLS) and is responsible for explicit organization_id
-- filtering in every query, resolved server-side from a verified session.
-- RLS still gets configured correctly here so it's a genuine second layer.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Organizations & membership
-- ---------------------------------------------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null check (role in ('owner', 'staff')),
  created_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index idx_organization_members_user on organization_members(user_id);

-- Replaces server/data/pharmacy-profile.json (single global file, v1 was
-- explicitly documented as single-location — now one row per org).
create table organization_profile (
  organization_id  uuid primary key references organizations(id) on delete cascade,
  state            text,
  city             text,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Shared reference data (NOT tenant-scoped — calendar dates aren't
-- tenant data; pre-seeded once, never deleted)
-- ---------------------------------------------------------------------

create table calendar (
  id            bigint generated always as identity primary key,
  date          date not null unique,
  year          integer not null,
  quarter       integer not null check (quarter between 1 and 4),
  month         integer not null check (month between 1 and 12),
  week          integer not null check (week between 1 and 53),
  day           integer not null check (day between 1 and 31),
  day_of_week   integer not null check (day_of_week between 0 and 6),
  month_name    text not null,
  day_name      text not null,
  is_weekend    boolean not null default false,
  is_holiday    boolean not null default false
);

-- ---------------------------------------------------------------------
-- Tenant-scoped star schema (was dim_product/dim_branch/dim_employee/
-- dim_customer/fact_sales)
-- ---------------------------------------------------------------------

create table product (
  id                     bigint generated always as identity primary key,
  organization_id        uuid not null references organizations(id) on delete cascade,
  natural_key            text not null,
  name                   text not null,
  category               text,
  brand                  text,
  is_generic             text default 'No',
  pack_size              text,
  list_price             numeric,
  standard_cost          numeric,
  launch_date            date,
  is_discontinued        text default 'No',
  discontinued_date      date,
  created_at             timestamptz not null default now(),
  -- Resolved identity (NAFDAC enrichment)
  resolved_brand         text,
  resolved_generic       text,
  resolved_manufacturer  text,
  resolved_strength      text,
  resolved_form          text,
  resolved_nafdac_no     text,
  resolution_status      text,
  -- Clinical identity
  clinical_product_id    text,
  therapeutic_class      text,
  active_ingredients     text,
  resolution_tier        text,
  unique (organization_id, natural_key)
);

create table branch (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  natural_key       text not null,
  name              text not null,
  location          text,
  created_at        timestamptz not null default now(),
  unique (organization_id, natural_key)
);

create table employee (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  natural_key       text not null,
  name              text not null,
  role              text,
  branch_id         bigint references branch(id),
  created_at        timestamptz not null default now(),
  unique (organization_id, natural_key)
);

create table customer (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  natural_key       text not null,
  name              text not null,
  type              text check (type in ('walk-in', 'hmo', 'corporate', 'nhis', 'family')),
  hmo_code          text,
  created_at        timestamptz not null default now(),
  unique (organization_id, natural_key)
);

create table sale (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  product_id        bigint not null references product(id),
  branch_id         bigint references branch(id),
  employee_id       bigint references employee(id),
  customer_id       bigint references customer(id),
  calendar_id       bigint not null references calendar(id),
  sale_date         date not null, -- denormalized from calendar.date at insert time; avoids a join for the date-range filters used throughout the app
  quantity          numeric not null default 1,
  unit_price        numeric not null default 0,
  unit_cost         numeric,
  payment_method    text check (payment_method in ('Cash', 'Transfer', 'POS', 'Insurance', 'Credit')),
  invoice_ref       text,
  created_at        timestamptz not null default now()
);

create index idx_sale_org_date     on sale(organization_id, sale_date);
create index idx_sale_org_product  on sale(organization_id, product_id);
create index idx_sale_org_branch   on sale(organization_id, branch_id);
create index idx_sale_org_customer on sale(organization_id, customer_id);

-- ---------------------------------------------------------------------
-- App-data tables (replace the 4 JSON-file stores)
-- ---------------------------------------------------------------------

-- Replaces server/data/dataset-registry.json (datasetRegistry.js)
create table dataset_registry (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  filename            text not null,
  mime_type           text,
  upload_timestamp    timestamptz not null default now(),
  capabilities        jsonb,
  mapped_columns      jsonb,
  normalized_schema   jsonb,
  processing_status   text,
  row_count           integer,
  sheet_names         jsonb,
  fingerprint         text,
  file_size           bigint,
  mapping_version     integer,
  asset_type          text,
  updated_at          timestamptz not null default now()
);

create index idx_dataset_registry_org on dataset_registry(organization_id);
create index idx_dataset_registry_org_fingerprint on dataset_registry(organization_id, fingerprint);

-- Replaces server/data/fact-store.json (factStore.js) — collapses the six
-- schema-less arrays (FactSales/FactInventory/DimProduct/DimCustomer/
-- DimSupplier/DimDate) into one org-scoped table with a discriminator +
-- JSONB payload, preserving today's schema-less flexibility.
create table widget_fact (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  table_name        text not null, -- 'FactSales' | 'FactInventory' | 'DimProduct' | 'DimCustomer' | 'DimSupplier' | 'DimDate'
  dataset_id        uuid references dataset_registry(id) on delete cascade,
  payload           jsonb not null,
  ingested_at       timestamptz not null default now()
);

create index idx_widget_fact_org_table on widget_fact(organization_id, table_name);
create index idx_widget_fact_dataset   on widget_fact(dataset_id);

-- Replaces server/mappings/*.json (columnMapper.js) — drops the
-- always-'default' pharmacyId param in favor of the real organization_id.
create table column_mapping (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  fingerprint        text not null,
  mapping           jsonb not null,
  saved_at          timestamptz not null default now(),
  unique (organization_id, fingerprint)
);

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------

create or replace function is_org_member(org_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org_id and user_id = auth.uid()
  );
$$;

alter table organizations         enable row level security;
alter table organization_members  enable row level security;
alter table organization_profile  enable row level security;
alter table product               enable row level security;
alter table branch                enable row level security;
alter table employee              enable row level security;
alter table customer              enable row level security;
alter table sale                  enable row level security;
alter table dataset_registry      enable row level security;
alter table widget_fact           enable row level security;
alter table column_mapping        enable row level security;

-- organizations: any authenticated user may create one; only members may read/update it
create policy org_create on organizations for insert with check (auth.uid() is not null);
create policy org_read   on organizations for select using (is_org_member(id));
create policy org_update on organizations for update using (is_org_member(id)) with check (is_org_member(id));

-- organization_members: members can see their own org's roster; only the
-- server (service_role, which bypasses RLS) writes new membership rows —
-- staff invites are a deferred v1 feature, so no client-facing insert policy yet.
create policy org_members_read on organization_members for select using (is_org_member(organization_id));

-- Standard select/insert/update triad, applied identically to every
-- tenant table below.
create policy org_select on organization_profile for select using (is_org_member(organization_id));
create policy org_write  on organization_profile for insert with check (is_org_member(organization_id));
create policy org_update on organization_profile for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on product for select using (is_org_member(organization_id));
create policy org_write  on product for insert with check (is_org_member(organization_id));
create policy org_update on product for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on branch for select using (is_org_member(organization_id));
create policy org_write  on branch for insert with check (is_org_member(organization_id));
create policy org_update on branch for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on employee for select using (is_org_member(organization_id));
create policy org_write  on employee for insert with check (is_org_member(organization_id));
create policy org_update on employee for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on customer for select using (is_org_member(organization_id));
create policy org_write  on customer for insert with check (is_org_member(organization_id));
create policy org_update on customer for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on sale for select using (is_org_member(organization_id));
create policy org_write  on sale for insert with check (is_org_member(organization_id));
create policy org_update on sale for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on dataset_registry for select using (is_org_member(organization_id));
create policy org_write  on dataset_registry for insert with check (is_org_member(organization_id));
create policy org_update on dataset_registry for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on widget_fact for select using (is_org_member(organization_id));
create policy org_write  on widget_fact for insert with check (is_org_member(organization_id));
create policy org_update on widget_fact for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

create policy org_select on column_mapping for select using (is_org_member(organization_id));
create policy org_write  on column_mapping for insert with check (is_org_member(organization_id));
create policy org_update on column_mapping for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

-- ---------------------------------------------------------------------
-- Seed the shared calendar table (2015-01-01 through 2035-12-31)
-- ---------------------------------------------------------------------

insert into calendar (date, year, quarter, month, week, day, day_of_week, month_name, day_name, is_weekend)
select
  d::date,
  extract(year from d)::int,
  extract(quarter from d)::int,
  extract(month from d)::int,
  extract(week from d)::int,
  extract(day from d)::int,
  extract(dow from d)::int,
  to_char(d, 'FMMonth'),
  to_char(d, 'FMDay'),
  extract(dow from d) in (0, 6)
from generate_series('2015-01-01'::date, '2035-12-31'::date, interval '1 day') as d
on conflict (date) do nothing;
