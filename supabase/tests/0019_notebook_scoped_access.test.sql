begin;
select plan(21);

select has_table('notesdb', 'api_token_notebook_grants', 'token notebook grants exist');
select has_column('notesdb', 'api_tokens', 'access_mode', 'tokens record the access mode');
select has_column('notesdb', 'api_tokens', 'allow_unfiled', 'tokens record unfiled access');
select has_column('notesdb', 'api_tokens', 'policy_revision', 'tokens record policy revisions');
select ok(not has_table_privilege('authenticated', 'notesdb.api_token_notebook_grants', 'SELECT'), 'authenticated cannot read token grants directly');
select ok(not has_function_privilege('anon', 'public.qnotes_api_token_access(uuid,uuid)', 'EXECUTE'), 'anon cannot read token access policy');
select ok(has_function_privilege('service_role', 'public.qnotes_api_token_access(uuid,uuid)', 'EXECUTE'), 'service role can read token access policy');

insert into notesdb.notebooks (id, owner_id, name) values
  ('a9000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'US09 A'),
  ('a9000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'US09 B');
insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, notebook_id, version, last_mutation_id, updated_by_device_id)
values
  ('a9000000-0000-4000-8000-000000000011', (select id from auth.users where email = 'owner@qnotes.local'), 'us09-a', 'US09 A', 'us09-marker', 'us09-marker', '{}', 'a9000000-0000-4000-8000-000000000001', 1, gen_random_uuid(), gen_random_uuid()),
  ('a9000000-0000-4000-8000-000000000012', (select id from auth.users where email = 'owner@qnotes.local'), 'us09-b', 'US09 B', 'us09-marker', 'us09-marker', '{}', 'a9000000-0000-4000-8000-000000000002', 1, gen_random_uuid(), gen_random_uuid()),
  ('a9000000-0000-4000-8000-000000000013', (select id from auth.users where email = 'owner@qnotes.local'), 'us09-unfiled', 'US09 Unfiled', 'us09-marker', 'us09-marker', '{}', null, 1, gen_random_uuid(), gen_random_uuid());
insert into notesdb.search_documents (id, owner_id, note_id, source_type, source_key, source_title, content, content_hash, position, embedding_status)
values
  ('a9000000-0000-4000-8000-000000000021', (select id from auth.users where email = 'owner@qnotes.local'), 'a9000000-0000-4000-8000-000000000011', 'note_chunk', 'us09-a', 'US09 A', 'us09-marker', 'us09-a', 0, 'pending'),
  ('a9000000-0000-4000-8000-000000000022', (select id from auth.users where email = 'owner@qnotes.local'), 'a9000000-0000-4000-8000-000000000012', 'note_chunk', 'us09-b', 'US09 B', 'us09-marker', 'us09-b', 0, 'pending'),
  ('a9000000-0000-4000-8000-000000000023', (select id from auth.users where email = 'owner@qnotes.local'), 'a9000000-0000-4000-8000-000000000013', 'note_chunk', 'us09-unfiled', 'US09 Unfiled', 'us09-marker', 'us09-unfiled', 0, 'pending');

create temporary table us09_account_token on commit drop as
select public.qnotes_create_api_token(
  (select id from auth.users where email = 'owner@qnotes.local'), 'US09 account', 'qnt_us09_account', repeat('a', 64), ARRAY['notes:read']::text[], null,
  'account', true, '{}'::uuid[]
) as response;
select is((select response->'access'->>'mode' from us09_account_token), 'account', 'account-wide token records its explicit mode');
select is((select response->'access'->>'allowUnfiled' from us09_account_token), 'true', 'account-wide access includes unfiled notes');

create temporary table us09_scoped_token on commit drop as
select public.qnotes_create_api_token(
  (select id from auth.users where email = 'owner@qnotes.local'), 'US09 notebook', 'qnt_us09_scoped', repeat('b', 64), ARRAY['notes:read','search:read']::text[], null,
  'notebooks', false, ARRAY['a9000000-0000-4000-8000-000000000001']::uuid[]
) as response;
select is((select response->'access'->>'mode' from us09_scoped_token), 'notebooks', 'scoped token records notebook mode');
select is((select jsonb_array_length(response->'access'->'notebookIds') from us09_scoped_token), 1, 'scoped token records one notebook grant');
select is((select response->'access'->>'allowUnfiled' from us09_scoped_token), 'false', 'scoped token denies unfiled notes unless granted');
select ok((select policy_revision > 1 from notesdb.api_tokens where token_hash = repeat('b', 64)), 'grant creation advances the policy revision');
select ok((select notebook_ids = ARRAY['a9000000-0000-4000-8000-000000000001']::uuid[] from public.qnotes_api_token_access((select id from notesdb.api_tokens where token_hash = repeat('b', 64)), (select id from auth.users where email = 'owner@qnotes.local'))), 'authentication reads the exact notebook grant');

select is((select count(*)::integer from public.qnotes_keyword_search_scoped((select id from auth.users where email = 'owner@qnotes.local'), 'us09-marker', 50, '{}'::jsonb, 0, 2, ARRAY['a9000000-0000-4000-8000-000000000001']::uuid[], false)), 1, 'scoped keyword search returns only the granted notebook');
select ok((select not exists (select 1 from public.qnotes_keyword_search_scoped((select id from auth.users where email = 'owner@qnotes.local'), 'us09-marker', 50, '{}'::jsonb, 0, 2, ARRAY['a9000000-0000-4000-8000-000000000001']::uuid[], false) where note_id in ('a9000000-0000-4000-8000-000000000012', 'a9000000-0000-4000-8000-000000000013'))), 'scoped search excludes notebook B and unfiled notes');
select is((select count(*)::integer from public.qnotes_keyword_search_scoped((select id from auth.users where email = 'owner@qnotes.local'), 'us09-marker', 50, '{}'::jsonb, 0, 2, '{}'::uuid[], true)), 1, 'unfiled permission is explicit and independent');
select is((select count(*)::integer from public.qnotes_search_freshness_scoped((select id from auth.users where email = 'owner@qnotes.local'), ARRAY['a9000000-0000-4000-8000-000000000001']::uuid[], false)), 1, 'freshness counts only authorized notebook documents');

select ok((select policy_revision > 1 from notesdb.api_tokens where token_hash = repeat('b', 64)), 'policy revision is present before grant changes');
delete from notesdb.api_token_notebook_grants where token_id = (select id from notesdb.api_tokens where token_hash = repeat('b', 64));
select ok((select policy_revision > 2 from notesdb.api_tokens where token_hash = repeat('b', 64)), 'grant revocation advances the policy revision');
select is((select cardinality(notebook_ids) from public.qnotes_api_token_access((select id from notesdb.api_tokens where token_hash = repeat('b', 64)), (select id from auth.users where email = 'owner@qnotes.local'))), 0, 'revoked grants are absent from the next policy snapshot');

select * from finish();
rollback;
