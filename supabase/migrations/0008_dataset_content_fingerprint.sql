-- Identify a dataset by what is IN it, not by the file that carried it.
--
-- dataset_registry.fingerprint hashes the first 64 KB, the byte length and the
-- filename, so "the same dataset" meant "a byte-identical file with the same
-- name". Two ordinary things break that:
--
--   * the same export downloaded twice  -> "report.xlsx" vs "report (1).xlsx"
--   * the same data exported again      -> Excel rewrites metadata, so the
--                                          bytes differ though the rows do not
--
-- Each produced a fresh dataset_id, and because every replace is scoped
-- `where dataset_id = ...`, the previous copy's rows survived and every total
-- counted the same sales twice.
--
-- content_fingerprint hashes the parsed rows instead: filename-independent,
-- byte-independent, and insensitive to row order. It is nullable because rows
-- registered before this migration have none — they acquire one the next time
-- they are processed.
alter table dataset_registry add column if not exists content_fingerprint text;

create index if not exists idx_dataset_registry_content
  on dataset_registry(organization_id, content_fingerprint);
