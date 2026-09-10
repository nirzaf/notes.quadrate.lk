begin;
select plan(18);

select has_column('notesdb', 'search_documents', 'embedding_attempts', 'search documents track provider attempts separately from queue reads');
select has_column('notesdb', 'search_documents', 'embedding_mode', 'search documents identify synthetic test vectors separately');
select col_default_is('notesdb', 'search_documents', 'embedding_attempts', '0', 'provider attempts start at zero');
select col_default_is('notesdb', 'search_documents', 'embedding_mode', 'provider', 'provider mode is the default identity');
select has_function('public', 'qnotes_requeue_embedding_failures', array['integer'], 'operator requeue function is present');
select has_function('public', 'qnotes_requeue_embedding_mode_mismatches', array['text', 'integer'], 'mode transition requeue function is present');
select has_function('public', 'qnotes_requeue_stale_embeddings', array['interval'], 'stale recovery function remains present');
select throws_ok($$select public.qnotes_requeue_embedding_failures(0)$$, '22023', 'embedding requeue limit must be between 1 and 1000', 'operator requeue rejects an unbounded or empty batch');
select ok(
  not has_function_privilege('anon', 'public.qnotes_requeue_embedding_failures(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.qnotes_requeue_embedding_failures(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.qnotes_requeue_embedding_failures(integer)', 'EXECUTE'),
  'operator requeue is restricted to service_role'
);
insert into notesdb.notes (
  id, owner_id, slug, title, content_markdown, content_plain, tags,
  version, last_mutation_id, updated_by_device_id
) values (
  '88888888-8888-4888-8888-888888888801',
  (select id from auth.users where email = 'owner@qnotes.local'),
  'us26-synthetic-isolation', 'US26 Synthetic Isolation',
  'synthetic-vector-marker', 'synthetic-vector-marker', '{}',
  1, gen_random_uuid(), gen_random_uuid()
);
insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, content,
  content_hash, position, embedding_status, embedding_error
) values (
  '88888888-8888-4888-8888-888888888804',
  (select id from auth.users where email = 'owner@qnotes.local'),
  '88888888-8888-4888-8888-888888888801', 'note_chunk', 'us26-retryable-failure',
  'US26 Retryable Failure', 'retryable embedding failure', 'us26-retryable-hash',
  2, 'failed', 'EMBEDDING_FAILED'
);
update notesdb.search_documents set embedding_attempts = 1
where id = '88888888-8888-4888-8888-888888888804';
select is(public.qnotes_requeue_embedding_failures(100), 0, 'operator requeue leaves non-terminal failures for the normal retry budget');
select is((select embedding_attempts from notesdb.search_documents where id = '88888888-8888-4888-8888-888888888804'), 1, 'non-terminal failure attempts are unchanged');
insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, content,
  content_hash, position, embedding, embedding_status, embedding_model,
  embedding_model_version, embedding_input_hash, embedding_mode
) values (
  '88888888-8888-4888-8888-888888888802',
  (select id from auth.users where email = 'owner@qnotes.local'),
  '88888888-8888-4888-8888-888888888801', 'note_chunk', 'us26-synthetic',
  'US26 Synthetic Isolation', 'synthetic-vector-marker', 'us26-synthetic-hash',
  0, ('[' || repeat('0,', 383) || '0]')::extensions.vector, 'ready',
  'gte-small', 'v2',
  public.qnotes_embedding_input_hash('US26 Synthetic Isolation', null, 'synthetic-vector-marker'),
  'synthetic-test-v1'
);
insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, content,
  content_hash, position, embedding, embedding_status, embedding_model,
  embedding_model_version, embedding_input_hash
) values (
  '88888888-8888-4888-8888-888888888803',
  (select id from auth.users where email = 'owner@qnotes.local'),
  '88888888-8888-4888-8888-888888888801', 'note_chunk', 'us26-provider',
  'US26 Provider Isolation', 'synthetic-vector-marker', 'us26-provider-hash',
  1, ('[' || repeat('0,', 383) || '0]')::extensions.vector, 'ready',
  'gte-small', 'v2',
  public.qnotes_embedding_input_hash('US26 Provider Isolation', null, 'synthetic-vector-marker')
);
select is((select count(*)::integer from public.qnotes_semantic_search(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'synthetic-vector-marker', ('[' || repeat('0,', 383) || '0]')::extensions.vector,
  10, '{}'::jsonb, 0, 2)
  where source_key = 'us26-synthetic'
), 0, 'provider semantic search excludes synthetic vectors');
select is((select count(*)::integer from public.qnotes_semantic_search(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'synthetic-vector-marker', ('[' || repeat('0,', 383) || '0]')::extensions.vector,
  10, '{"embeddingMode":"synthetic-test-v1"}'::jsonb, 0, 2)
  where source_key = 'us26-synthetic'
), 1, 'explicit synthetic semantic search includes synthetic vectors');
select is((select count(*)::integer from public.qnotes_hybrid_search(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'synthetic-vector-marker', ('[' || repeat('0,', 383) || '0]')::extensions.vector,
  10, 60)
  where source_key = 'us26-synthetic'
), 0, 'provider hybrid search excludes synthetic vectors');
select is((select count(*)::integer from public.qnotes_hybrid_search(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'synthetic-vector-marker', ('[' || repeat('0,', 383) || '0]')::extensions.vector,
  10, 60, '{"embeddingMode":"synthetic-test-v1"}'::jsonb, 0, 2)
  where source_key = 'us26-synthetic'
), 1, 'explicit synthetic hybrid search includes synthetic vectors');
select is(public.qnotes_requeue_embedding_mode_mismatches('provider', 100), 1, 'mode transition requeues mismatched ready vectors');
select is((select embedding_status from notesdb.search_documents where id = '88888888-8888-4888-8888-888888888802'), 'pending', 'mode transition clears the mismatched ready state');
select ok(
  not has_function_privilege('anon', 'public.qnotes_requeue_embedding_mode_mismatches(text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.qnotes_requeue_embedding_mode_mismatches(text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.qnotes_requeue_embedding_mode_mismatches(text,integer)', 'EXECUTE'),
  'mode transition requeue is restricted to service_role'
);

select * from finish();
rollback;
