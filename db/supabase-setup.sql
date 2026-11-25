-- One-time setup for running SignuDoc inside an existing Supabase project,
-- next to another app. Run it once in the project's SQL editor, as postgres,
-- after replacing the password. See docs/netlify-supabase.md.
--
-- What it makes:
--   * a login role, signudoc_app, that SignuDoc connects as;
--   * a schema, signudoc, owned by that role, that SignuDoc's migrations
--     fill. The project's API (PostgREST) only serves the schemas listed
--     under Settings, API, so nothing here is reachable with the anon key;
--   * a private Storage bucket, signudoc, for the documents.
--
-- signudoc_app gets nothing in public or any other schema, so SignuDoc
-- cannot read the other app's tables, and the other app's API keys cannot
-- read SignuDoc's.

create role signudoc_app
  with login noinherit nocreatedb nocreaterole
  password 'REPLACE-WITH-A-LONG-RANDOM-PASSWORD';

-- Unqualified names (all of SignuDoc's queries) resolve to its own schema.
-- Set on the role, so it holds through Supabase's connection pooler too.
alter role signudoc_app set search_path = signudoc;

-- Supabase's own limit for API roles is 8s; signing and sealing a large PDF
-- can take longer than that, so give this role more room.
alter role signudoc_app set statement_timeout = '60s';

create schema if not exists signudoc authorization signudoc_app;
revoke all on schema signudoc from public;

-- Make sure the API roles cannot reach it even if someone later adds the
-- schema to the API's exposed list by mistake.
revoke all on schema signudoc from anon, authenticated;
alter default privileges for role signudoc_app in schema signudoc
  revoke all on tables from anon, authenticated;
alter default privileges for role signudoc_app in schema signudoc
  revoke all on sequences from anon, authenticated;
alter default privileges for role signudoc_app in schema signudoc
  revoke all on functions from anon, authenticated, public;

-- Private bucket for PDFs, sealed copies, certificates, thumbnails and the
-- brand logo. Only SignuDoc's server touches it, with the service role key.
-- 50 MB leaves room for a 20 MB upload to grow as it is signed and sealed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('signudoc', 'signudoc', false, 52428800)
on conflict (id) do nothing;
