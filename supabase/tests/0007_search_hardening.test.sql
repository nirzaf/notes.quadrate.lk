begin;
select plan(25);

-- Stable create input, including a title that falls back to note-untitled in
-- the API, is idempotent even when the retry supplies a fresh candidate ID.
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777701', 'note-untitled', '運用メモ', 'body', 'body', '{}',
  '77777777-7777-4777-8777-777777777702', '77777777-7777-4777-8777-777777777703',
  'stable-create-hash', '[]'::jsonb, '[]'::jsonb, null, null
)->>'status'), 'ok', 'unicode fallback-slug create succeeds');
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777704', 'note-untitled', '運用メモ', 'body', 'body', '{}',
  '77777777-7777-4777-8777-777777777702', '77777777-7777-4777-8777-777777777703',
  'stable-create-hash', '[]'::jsonb, '[]'::jsonb, null, null
)->>'status'), 'idempotent', 'identical create retry returns the stored mutation');
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777705', 'note-untitled', '運用メモ changed', 'body', 'body', '{}',
  '77777777-7777-4777-8777-777777777702', '77777777-7777-4777-8777-777777777703',
  'different-create-hash', '[]'::jsonb, '[]'::jsonb, null, null
)->>'status'), 'mutation_reuse_conflict', 'changed create input with a reused mutation conflicts');

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777730', 'capture-a', 'Capture A', '', '', '{}',
  '77777777-7777-4777-8777-777777777731', '77777777-7777-4777-8777-777777777732',
  'capture-a-hash', '[]'::jsonb, '[]'::jsonb, null, 'capture-key'
)->>'status'), 'ok', 'capture dedupe fixture is created');
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777733', 'capture-b', 'Capture B', '', '', '{}',
  '77777777-7777-4777-8777-777777777734', '77777777-7777-4777-8777-777777777735',
  'capture-b-hash', '[]'::jsonb, '[]'::jsonb, null, 'capture-key'
)->>'status'), 'dedupe_existing', 'capture reports an active dedupe result');
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777736', 'capture-c', 'Capture C changed', '', '', '{}',
  '77777777-7777-4777-8777-777777777734', '77777777-7777-4777-8777-777777777735',
  'capture-c-hash', '[]'::jsonb, '[]'::jsonb, null, 'capture-key'
)->>'status'), 'mutation_reuse_conflict', 'changed deduplicated capture conflicts on mutation reuse');

-- Dedupe uniqueness is checked before restore can trip the partial unique
-- index, and the explicit status is stable for API error mapping.
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777706', 'restore-dedupe-a', 'Restore Dedupe A', '', '', '{}',
  '77777777-7777-4777-8777-777777777707', '77777777-7777-4777-8777-777777777708',
  'restore-a-create', '[]'::jsonb, '[]'::jsonb, null, 'restore-key'
)->>'status'), 'ok', 'restore dedupe fixture A is created');
select is((public.qnotes_soft_delete_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777706', 1,
  '77777777-7777-4777-8777-777777777707', '77777777-7777-4777-8777-777777777709', 'restore-a-delete'
)->>'status'), 'ok', 'restore dedupe fixture A is deleted');
select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777710', 'restore-dedupe-b', 'Restore Dedupe B', '', '', '{}',
  '77777777-7777-4777-8777-777777777711', '77777777-7777-4777-8777-777777777712',
  'restore-b-create', '[]'::jsonb, '[]'::jsonb, null, 'restore-key'
)->>'status'), 'ok', 'restore dedupe fixture B is created');
select is((public.qnotes_restore_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '77777777-7777-4777-8777-777777777706', 2,
  '77777777-7777-4777-8777-777777777707', '77777777-7777-4777-8777-777777777713', 'restore-a-restore'
)->>'status'), 'dedupe_conflict', 'restore reports an active dedupe conflict');

-- More than the public 50-row boundary remains reachable through the bounded
-- service-role candidate limit, including a deep hybrid page.
with new_notes as (
  insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
  select gen_random_uuid(), (select id from auth.users where email = 'owner@qnotes.local'),
    'deep-hybrid-' || s::text, 'Deep Hybrid ' || s::text, 'deep-hybrid-marker', 'deep-hybrid-marker', '{}', 1, gen_random_uuid(), gen_random_uuid()
  from generate_series(1, 60) as values(s)
  returning id, owner_id, title
)
insert into notesdb.search_documents (owner_id, note_id, source_type, source_key, source_title, heading_path, content, content_hash, position, embedding_status)
select owner_id, id, 'note_chunk', 'deep-hybrid-' || id::text, title, null, 'deep-hybrid-marker', md5(id::text), 0, 'pending'
from new_notes;
select is((select count(*)::integer from public.qnotes_hybrid_search(
  (select id from auth.users where email = 'owner@qnotes.local'), 'deep-hybrid-marker',
  ('[' || repeat('0,', 383) || '0]')::extensions.vector, 60, 60
)), 60, 'hybrid retrieval reaches candidates beyond the old 51-row clamp');
select is((select count(*)::integer from public.qnotes_hybrid_search(
  (select id from auth.users where email = 'owner@qnotes.local'), 'deep-hybrid-marker',
  ('[' || repeat('0,', 383) || '0]')::extensions.vector, 20, 60, '{}'::jsonb, 51, 1
)), 9, 'deep hybrid pagination returns the remaining rows');

-- Pagination is applied after ranking and caps without consuming the hidden
-- lookahead row; three pages cover all six distinct document identities.
with new_notes as (
  insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
  select gen_random_uuid(), (select id from auth.users where email = 'owner@qnotes.local'),
    'page-' || s::text, 'Page ' || s::text, 'pagination-marker', 'pagination-marker', '{}', 1, gen_random_uuid(), gen_random_uuid()
  from generate_series(1, 6) as values(s)
  returning id, owner_id, title
)
insert into notesdb.search_documents (owner_id, note_id, source_type, source_key, source_title, heading_path, content, content_hash, position, embedding_status)
select owner_id, id, 'note_chunk', 'page-' || id::text, title, null, 'pagination-marker', md5(id::text), 0, 'pending'
from new_notes;
select is((select count(*)::integer from (
  select id from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'pagination-marker', 2, '{}'::jsonb, 0, 1)
  union all select id from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'pagination-marker', 2, '{}'::jsonb, 2, 1)
  union all select id from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'pagination-marker', 2, '{}'::jsonb, 4, 1)
) pages), 6, 'three keyword pages contain every row without a gap');
select is((select count(*)::integer from (
  select id from (
    select id from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'pagination-marker', 2, '{}'::jsonb, 0, 1)
    union all select id from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'pagination-marker', 2, '{}'::jsonb, 2, 1)
    union all select id from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'pagination-marker', 2, '{}'::jsonb, 4, 1)
  ) pages
  group by id
  having count(*) > 1
) duplicates), 0, 'paged keyword results have no duplicate document identities');

-- Filters are applied before the top-K and per-note cap.
with target_note as (
  insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
  values ('77777777-7777-4777-8777-777777777720', (select id from auth.users where email = 'owner@qnotes.local'), 'filter-target', 'Filter Target', 'filter-before-limit', 'filter-before-limit', '{target}', 1, gen_random_uuid(), gen_random_uuid())
  returning id, owner_id, title
), competing_notes as (
  insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
  select gen_random_uuid(), (select id from auth.users where email = 'owner@qnotes.local'), 'filter-competitor-' || s::text, 'Filter Competitor ' || s::text, 'filter-before-limit', 'filter-before-limit', '{}', 1, gen_random_uuid(), gen_random_uuid()
  from generate_series(1, 60) as values(s)
  returning id, owner_id, title
), all_notes as (
  select * from target_note union all select * from competing_notes
)
insert into notesdb.search_documents (owner_id, note_id, source_type, source_key, source_title, heading_path, content, content_hash, position, embedding_status)
select owner_id, id, 'note_chunk', 'filter-' || id::text, title, null, 'filter-before-limit', md5(id::text), 0, 'pending' from all_notes;
select is((select count(*)::integer from public.qnotes_keyword_search(
  (select id from auth.users where email = 'owner@qnotes.local'), 'filter-before-limit', 2,
  '{"tags":["target"]}'::jsonb, 0, 1
)), 1, 'tag filtering happens before top-K competition');

-- Notebook, tag, source, language, Unfiled, and updated-after filters all
-- remain owner-scoped.
insert into notesdb.notebooks (id, owner_id, name) values ('77777777-7777-4777-8777-777777777721', (select id from auth.users where email = 'owner@qnotes.local'), 'Search Hardening');
insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, notebook_id, version, last_mutation_id, updated_by_device_id, updated_at)
values ('77777777-7777-4777-8777-777777777722', (select id from auth.users where email = 'owner@qnotes.local'), 'filtered-code', 'Filtered Code', 'filtered-code-marker', 'filtered-code-marker', '{ops}', '77777777-7777-4777-8777-777777777721', 1, gen_random_uuid(), gen_random_uuid(), '2026-01-02T00:00:00Z');
insert into notesdb.note_blocks (id, owner_id, note_id, block_key, block_type, title, language, content, position, content_hash)
values ('77777777-7777-4777-8777-777777777723', (select id from auth.users where email = 'owner@qnotes.local'), '77777777-7777-4777-8777-777777777722', 'filtered-code', 'code', 'Filtered Code', 'bash', 'filtered-code-marker', 0, 'filtered-code-hash');
insert into notesdb.search_documents (owner_id, note_id, source_type, source_id, source_key, source_title, content, content_hash, position, embedding_status)
values ((select id from auth.users where email = 'owner@qnotes.local'), '77777777-7777-4777-8777-777777777722', 'code_block', '77777777-7777-4777-8777-777777777723', 'filtered-code', 'Filtered Code', 'filtered-code-marker', 'filtered-code-doc-hash', 0, 'pending');
select is((select count(*)::integer from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'filtered-code-marker', 10, '{"notebookIds":["77777777-7777-4777-8777-777777777721"],"tags":["ops"],"sourceTypes":["code_block"],"languages":["bash"],"updatedAfter":"2026-01-01T00:00:00Z"}'::jsonb, 0, 2)), 1, 'notebook tag source language and updated-after filters compose');
select is((select count(*)::integer from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), 'filtered-code-marker', 10, '{"unfiled":true}'::jsonb, 0, 2)), 0, 'Unfiled filtering excludes filed notes');

-- Current v2 vectors participate; incompatible v1 state is cleared and does
-- not participate in semantic retrieval.
insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
values ('77777777-7777-4777-8777-777777777724', (select id from auth.users where email = 'owner@qnotes.local'), 'semantic-v2', 'Semantic V2', 'semantic-v2-marker', 'semantic-v2-marker', '{}', 1, gen_random_uuid(), gen_random_uuid());
insert into notesdb.search_documents (owner_id, note_id, source_type, source_key, source_title, content, content_hash, position, embedding, embedding_status, embedding_model, embedding_model_version, embedding_input_hash)
values ((select id from auth.users where email = 'owner@qnotes.local'), '77777777-7777-4777-8777-777777777724', 'note_chunk', 'semantic-v2', 'Semantic V2', 'semantic-v2-marker', 'semantic-v2-content', 0, ('[' || repeat('0,', 383) || '0]')::extensions.vector, 'ready', 'gte-small', 'v2', public.qnotes_embedding_input_hash('Semantic V2', null, 'semantic-v2-marker'));
insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
values ('77777777-7777-4777-8777-777777777725', (select id from auth.users where email = 'owner@qnotes.local'), 'semantic-v1', 'Semantic V1', 'semantic-v1-marker', 'semantic-v1-marker', '{}', 1, gen_random_uuid(), gen_random_uuid());
insert into notesdb.search_documents (owner_id, note_id, source_type, source_key, source_title, content, content_hash, position, embedding_status)
values ((select id from auth.users where email = 'owner@qnotes.local'), '77777777-7777-4777-8777-777777777725', 'note_chunk', 'semantic-v1', 'Semantic V1', 'semantic-v1-marker', 'semantic-v1-content', 0, 'pending');
alter table notesdb.search_documents disable trigger search_documents_prepare_embedding;
update notesdb.search_documents
set embedding = ('[' || repeat('0,', 383) || '0]')::extensions.vector,
    embedding_status = 'ready', embedding_model = 'gte-small', embedding_model_version = 'v1',
    embedding_input_hash = public.qnotes_embedding_input_hash(source_title, heading_path, content)
where source_key = 'semantic-v1';
alter table notesdb.search_documents enable trigger search_documents_prepare_embedding;
select ok((select count(*) > 0 from public.qnotes_semantic_search((select id from auth.users where email = 'owner@qnotes.local'), 'semantic-v2-marker', ('[' || repeat('0,', 383) || '0]')::extensions.vector, 10)), 'current v2 vectors participate in semantic search');
select ok((select not exists (
  select 1 from public.qnotes_semantic_search((select id from auth.users where email = 'owner@qnotes.local'), 'semantic-v1-marker', ('[' || repeat('0,', 383) || '0]')::extensions.vector, 10)
  where note_id = '77777777-7777-4777-8777-777777777725'
)), 'old v1-compatible work is absent from semantic search');
select ok((
  select position('qnotes_semantic_search(p_owner_id, '''', p_embedding, p_limit, ''{}''::jsonb, 0, 2)' in p.prosrc) > 0
    and not has_function_privilege('anon', p.oid, 'EXECUTE')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and has_function_privilege('service_role', p.oid, 'EXECUTE')
  from pg_proc p
  where p.oid = 'public.qnotes_semantic_search(uuid,extensions.vector,integer)'::regprocedure
), 'three-argument semantic compatibility wrapper delegates to v2 and is service-role only');

-- Input invalidation clears the vector, requeues current work from pending
-- state, and preserves attachment page provenance and freshness age.
update notesdb.search_documents set content = 'semantic-v2-marker changed', content_hash = 'semantic-v2-content-changed', embedding_status = 'ready' where source_key = 'semantic-v2';
select ok((select embedding_status = 'pending' and embedding is null and embedding_model_version = 'v2' from notesdb.search_documents where source_key = 'semantic-v2'), 'changed embedding input becomes pending without a stale vector');
select ok((select count(*) > 0 from pgmq.read('note-embeddings', 0, 100) where message->>'searchDocumentId' = (select id::text from notesdb.search_documents where source_key = 'semantic-v2')), 'changed pending input has a current embedding job');
update notesdb.search_documents set content = 'semantic-v2-marker pending changed', content_hash = 'semantic-v2-pending-hash', embedding_status = 'pending' where source_key = 'semantic-v2';
select ok((select count(*) > 0 from pgmq.read('note-embeddings', 0, 100) where message->>'searchDocumentId' = (select id::text from notesdb.search_documents where source_key = 'semantic-v2') and message->>'contentHash' = 'semantic-v2-pending-hash' and message->>'embeddingInputHash' = public.qnotes_embedding_input_hash('Semantic V2', null, 'semantic-v2-marker pending changed')), 'pending input changes enqueue the current invariants');
insert into notesdb.search_documents (owner_id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, embedding_status, embedding_queued_at)
values ((select id from auth.users where email = 'owner@qnotes.local'), '77777777-7777-4777-8777-777777777722', 'attachment_chunk', '77777777-7777-4777-8777-777777777723', 'attachment:77777777-7777-4777-8777-777777777723:page:3:abc', 'file.pdf — page 3', 'Page 3', 'page marker', 'attachment-page-hash', 0, 'pending', '2026-01-01T00:00:00Z');
select is((select page_number from notesdb.search_documents where source_key like 'attachment:%:page:3:%'), 3, 'attachment page number is persisted from provenance');
select ok((select pending_documents > 0 and oldest_queued_at <= '2026-01-01T00:00:00Z' from public.qnotes_search_freshness((select id from auth.users where email = 'owner@qnotes.local'))), 'freshness reports pending count and oldest queue age');

select * from finish();
rollback;
