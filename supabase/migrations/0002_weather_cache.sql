-- Weather Cache — owned by server/services/weather/weatherCache.js.
-- Self-contained, no foreign keys into the star schema (same design intent
-- as the original SQLite version — one cache row per state per day).

create table weather_intelligence (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  state           text not null,
  forecast_date   date not null,
  rainfall_mm     numeric,
  humidity        numeric,
  temperature     numeric,
  rainfall_risk   text,
  humidity_risk   text,
  heatwave_risk   text,
  harmattan_risk  text,
  cold_risk       text,
  condition_main  text,
  confidence      numeric,
  created_at      timestamptz not null default now(),
  unique (organization_id, state, forecast_date)
);

alter table weather_intelligence enable row level security;

create policy org_select on weather_intelligence for select using (is_org_member(organization_id));
create policy org_write  on weather_intelligence for insert with check (is_org_member(organization_id));
create policy org_update on weather_intelligence for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));
