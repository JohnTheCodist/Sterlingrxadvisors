-- Persists the web dashboard's AI Advisor conversation per organization —
-- today it lives only in client React state, so it vanishes on reload or
-- navigating away. Mirrors whatsapp_message's shape, minus phone_number
-- (web auth already scopes every request to organization_id).

create table advisor_message (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  role              text not null check (role in ('user', 'assistant')),
  content           text not null,
  created_at        timestamptz not null default now()
);
create index idx_advisor_message_org_time on advisor_message(organization_id, created_at desc);

alter table advisor_message enable row level security;

create policy org_select on advisor_message for select using (is_org_member(organization_id));
create policy org_write  on advisor_message for insert with check (is_org_member(organization_id));
