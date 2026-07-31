-- ---------------------------------------------------------------------
-- column_alias — what this pharmacy has already told us a column means.
--
-- column_mapping (0001) stores a mapping keyed by a fingerprint of the WHOLE
-- header set, so it only ever hits when a file's headers match exactly. Add,
-- remove or rename one column and every previously-confirmed answer is lost,
-- and the owner is asked to map from scratch again.
--
-- This remembers one column at a time. "ItemName means product_name" holds no
-- matter what else the file contains, which is what makes a question asked
-- once stay answered.
--
-- times_overridden counts how often a human REPLACED the detector's own guess
-- for this header. That is the strongest evidence in the system — a person
-- correcting a machine about a specific column — and it is tracked separately
-- from plain agreement so it can outrank the detector rather than merely tie.
-- ---------------------------------------------------------------------
create table if not exists column_alias (
  organization_id   uuid not null references organizations(id) on delete cascade,
  normalized_header text not null,
  category          text not null,
  times_confirmed   int  not null default 0,
  times_overridden  int  not null default 0,
  source            text not null default 'user', -- 'user' | 'whatsapp' | 'web'
  created_at        timestamptz not null default now(),
  last_seen         timestamptz not null default now(),
  primary key (organization_id, normalized_header)
);

create index if not exists idx_column_alias_org on column_alias(organization_id);

-- ---------------------------------------------------------------------
-- whatsapp_pending_upload — a file held mid-processing while we wait for
-- the owner to answer one clarifying question.
--
-- WhatsApp has no mapping screen, so until now an ambiguous column was
-- resolved by silently picking the better guess and reporting the result as
-- fact. For most columns that is the right trade. For the few that decide
-- headline numbers — which of two money columns is cost and which is price —
-- a wrong guess quietly corrupts every figure in the summary.
--
-- Asking costs one message, but a WhatsApp conversation is stateless between
-- webhooks, so the file has to be parked somewhere until the reply arrives.
-- Stored as bytea with an expiry, exactly like whatsapp_pdf_export.
--
-- One row per phone number: a newly sent file always replaces whatever was
-- waiting, so an ignored question can never strand a later upload.
-- ---------------------------------------------------------------------
create table if not exists whatsapp_pending_upload (
  phone_number      text primary key,
  organization_id   uuid not null references organizations(id) on delete cascade,
  file_data         bytea not null,
  filename          text not null,
  question          jsonb not null, -- { rawHeader, options: [{ label, category }], asked }
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null
);

create index if not exists idx_whatsapp_pending_upload_expires
  on whatsapp_pending_upload(expires_at);
