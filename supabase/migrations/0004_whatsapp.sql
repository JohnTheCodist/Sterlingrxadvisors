-- RxNaija Analytics — WhatsApp channel ("Alafia")
--
-- Adds phone-number → organization mapping (with onboarding state),
-- WhatsApp conversation history for the AI Advisor, and short-lived PDF
-- export hosting so Twilio can fetch a generated summary and relay it to
-- the pharmacy. Same isolation model as 0001_init.sql: organization_id on
-- every tenant row, RLS as defense-in-depth (the server's service_role
-- connection bypasses it and is responsible for explicit filtering).

-- ---------------------------------------------------------------------
-- whatsapp_contact — one row per phone number. Unifies phone->org mapping
-- and onboarding state (new -> awaiting_pharmacy_name -> complete) since
-- they're one lifecycle, not two independent concerns that could drift.
-- ---------------------------------------------------------------------

create table whatsapp_contact (
  id                 uuid primary key default gen_random_uuid(),
  phone_number       text not null unique, -- E.164, e.g. '+2348012345678'
  organization_id    uuid references organizations(id) on delete cascade,
  onboarding_status  text not null default 'new' check (onboarding_status in ('new', 'awaiting_pharmacy_name', 'complete')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_message_at    timestamptz
);

create index idx_whatsapp_contact_org on whatsapp_contact(organization_id);

-- ---------------------------------------------------------------------
-- whatsapp_message — AI Advisor conversation history per phone number.
-- Only written once a contact is resolved to an org; the onboarding Q&A
-- itself is a tiny state machine on whatsapp_contact, not an advisor
-- conversation, so it doesn't need a row here.
-- ---------------------------------------------------------------------

create table whatsapp_message (
  id                bigint generated always as identity primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  phone_number      text not null,
  role              text not null check (role in ('user', 'assistant')),
  content           text not null,
  created_at        timestamptz not null default now()
);

create index idx_whatsapp_message_org_phone_time on whatsapp_message(organization_id, phone_number, created_at desc);

-- ---------------------------------------------------------------------
-- whatsapp_pdf_export — short-lived, unguessable-URL PDF hosting so
-- Twilio can fetch a generated summary and relay it to the user. A DB
-- row (not an in-memory Map) so it survives a server restart. Expired
-- rows are lazy-deleted on read — no cron infrastructure exists today.
-- ---------------------------------------------------------------------

create table whatsapp_pdf_export (
  id                uuid primary key default gen_random_uuid(), -- doubles as the URL token
  organization_id   uuid not null references organizations(id) on delete cascade,
  filename          text not null,
  pdf_data          bytea not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null
);

create index idx_whatsapp_pdf_export_expires on whatsapp_pdf_export(expires_at);

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------

alter table whatsapp_contact     enable row level security;
alter table whatsapp_message     enable row level security;
alter table whatsapp_pdf_export  enable row level security;

-- whatsapp_contact: select-only for now (a possible future "connected
-- WhatsApp number" display in web Settings) — writes only ever come from
-- the server's service_role connection (webhook handler), never a client.
create policy org_select on whatsapp_contact for select using (is_org_member(organization_id));

-- whatsapp_message: standard select/insert/update triad, same as every
-- other tenant table in 0001_init.sql.
create policy org_select on whatsapp_message for select using (is_org_member(organization_id));
create policy org_write  on whatsapp_message for insert with check (is_org_member(organization_id));
create policy org_update on whatsapp_message for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));

-- whatsapp_pdf_export: RLS enabled with NO client-facing policies at all.
-- It's never read by an authenticated browser session — only by the
-- service-role connection and the public token-guarded /pdf/whatsapp/:id
-- route, which must never be re-implemented via PostgREST/the anon key.
