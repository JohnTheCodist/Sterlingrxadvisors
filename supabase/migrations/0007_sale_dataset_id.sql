-- Makes re-processing a file idempotent in the star schema.
--
-- loadFactRecords appends by design, so a pharmacy uploading this week's
-- file keeps every earlier week. But nothing distinguished "a new file" from
-- "the same file again", so re-processing one duplicated all of its rows —
-- observed live as 1,746 sale rows collapsing to 799 distinct combinations,
-- some repeated 6x, which then inflated every dashboard number and made the
-- AI Advisor report totals the owner did not recognise.
--
-- Tagging each sale row with the dataset it came from lets the loader
-- replace just that dataset's rows while leaving other uploads untouched --
-- the same per-dataset replace the widget_fact store already uses.

alter table sale add column dataset_id uuid references dataset_registry(id) on delete cascade;
create index idx_sale_org_dataset on sale(organization_id, dataset_id);
