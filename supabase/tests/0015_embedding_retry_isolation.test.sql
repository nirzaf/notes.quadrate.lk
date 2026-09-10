begin;
select plan(8);

select has_column('notesdb', 'search_documents', 'embedding_attempts', 'search documents track provider attempts separately from queue reads');
select has_column('notesdb', 'search_documents', 'embedding_mode', 'search documents identify synthetic test vectors separately');
select col_default_is('notesdb', 'search_documents', 'embedding_attempts', '0', 'provider attempts start at zero');
select col_default_is('notesdb', 'search_documents', 'embedding_mode', '''provider''', 'provider mode is the default identity');
select has_function('public', 'qnotes_requeue_embedding_failures', array['integer'], 'operator requeue function is present');
select has_function('public', 'qnotes_requeue_stale_embeddings', array['interval'], 'stale recovery function remains present');
select throws_ok($$select public.qnotes_requeue_embedding_failures(0)$$, '22023', 'embedding requeue limit must be between 1 and 1000', 'operator requeue rejects an unbounded or empty batch');
select ok(
  not has_function_privilege('anon', 'public.qnotes_requeue_embedding_failures(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.qnotes_requeue_embedding_failures(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.qnotes_requeue_embedding_failures(integer)', 'EXECUTE'),
  'operator requeue is restricted to service_role'
);

select * from finish();
rollback;
