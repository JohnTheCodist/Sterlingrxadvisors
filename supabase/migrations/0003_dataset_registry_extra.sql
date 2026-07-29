-- The original JSON-file dataset registry was fully schema-less (any field
-- could be merged in via update()). recommended_dashboards is one real
-- example already in use (server/services/datasetClassifier.js) that isn't
-- one of the well-known columns from migration 0001 — rather than
-- enumerating every ad-hoc field that might show up, add one generic
-- bucket for anything outside the well-known columns.

alter table dataset_registry add column extra jsonb not null default '{}'::jsonb;
