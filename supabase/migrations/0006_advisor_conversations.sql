-- Splits the AI Advisor's persisted history (0005) into bounded
-- conversations instead of one infinite lifetime thread per organization.
-- Without this, a question about a fresh upload gets answered using
-- context from analysis of a completely different, older upload — the
-- model can't tell they're unrelated.

create table advisor_conversation (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

-- At most one active conversation per organization at a time.
create unique index idx_advisor_conversation_one_active_per_org
  on advisor_conversation(organization_id) where is_active;
create index idx_advisor_conversation_org_created on advisor_conversation(organization_id, created_at desc);

alter table advisor_conversation enable row level security;
create policy org_select on advisor_conversation for select using (is_org_member(organization_id));
create policy org_write  on advisor_conversation for insert with check (is_org_member(organization_id));
create policy org_update on advisor_conversation for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

alter table advisor_message add column conversation_id uuid references advisor_conversation(id) on delete cascade;

-- Backfill: real conversation history already exists (advisor chat shipped
-- before this migration) — group each organization's existing messages into
-- one conversation rather than orphaning them, so nothing already written
-- is lost. Archived (is_active = false), not left active: this is exactly
-- the pre-conversations, everything-in-one-thread history the feature is
-- fixing, so the next message an org sends should start a fresh, empty
-- active conversation rather than continuing to build on it.
do $$
declare
  org record;
  new_conv_id uuid;
begin
  for org in select distinct organization_id from advisor_message where conversation_id is null loop
    insert into advisor_conversation (organization_id, is_active) values (org.organization_id, false)
    returning id into new_conv_id;
    update advisor_message set conversation_id = new_conv_id
      where organization_id = org.organization_id and conversation_id is null;
  end loop;
end $$;

alter table advisor_message alter column conversation_id set not null;
create index idx_advisor_message_conversation_time on advisor_message(conversation_id, created_at);
