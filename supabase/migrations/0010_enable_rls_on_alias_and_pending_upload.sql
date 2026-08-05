-- Close two tables that were left open to the internet.
--
-- Migration 0009 created column_alias and whatsapp_pending_upload but never
-- enabled row level security on them. Every other table in this schema has it.
-- Supabase's security advisor flagged both as "publicly accessible", and it is
-- right: the anon key is compiled into the browser bundle we serve from the
-- website, so it is public by construction. On a table without RLS that key can
-- read, modify and delete every row.
--
-- whatsapp_pending_upload is the one that matters. It holds phone_number,
-- filename, question and file_data -- a pharmacist's phone number attached to
-- the spreadsheet they just sent us. column_alias is less sensitive but still
-- leaks which organizations exist and what their spreadsheet columns are named.
--
-- NO POLICIES, DELIBERATELY. A table with RLS enabled and no policies denies
-- everything to anon and authenticated, which is exactly right here: nothing in
-- the browser touches either table. The client uses Supabase only for
-- auth (getSession, signIn, signUp, signOut -- verified across client/src), and
-- every read of application data goes through our own /api routes.
--
-- The server is unaffected. It connects as `postgres`, which has rolbypassrls,
-- so its queries never consult a policy. Confirmed by querying pg_roles rather
-- than assuming it.
--
-- Adding permissive policies later is easy; leaving a table world-writable
-- because a policy might one day be wanted is not a trade worth making.

alter table column_alias            enable row level security;
alter table whatsapp_pending_upload enable row level security;
