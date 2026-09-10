begin;
select plan(13);

select ok(
  has_function_privilege(
    'service_role',
    'public.qnotes_measure_tenant_vector_recall(uuid,extensions.vector,jsonb,uuid[],boolean,integer)'::regprocedure,
    'EXECUTE'
  ),
  'recall measurement is available to service_role'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.qnotes_measure_tenant_vector_recall(uuid,extensions.vector,jsonb,uuid[],boolean,integer)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.qnotes_measure_tenant_vector_recall(uuid,extensions.vector,jsonb,uuid[],boolean,integer)'::regprocedure,
    'EXECUTE'
  ),
  'recall measurement is not exposed to client roles'
);
select ok(
  public.qnotes_configure_hnsw_search(false) in ('iterative', 'ef_search', 'default')
    and current_setting('enable_seqscan') = 'off'
    and current_setting('enable_bitmapscan') = 'off',
  'HNSW settings are transaction-local and bounded'
);

insert into notesdb.notebooks (id, owner_id, name)
values
  ('85000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'US23 A'),
  ('85000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'US23 B');

insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, notebook_id, version, last_mutation_id, updated_by_device_id)
values
  ('85000000-0000-4000-8000-000000000011', (select id from auth.users where email = 'owner@qnotes.local'), 'us23-small', 'US23 Small', 'us23-small', 'us23-small', '{us23-small}', '85000000-0000-4000-8000-000000000001', 1, gen_random_uuid(), gen_random_uuid()),
  ('85000000-0000-4000-8000-000000000012', (select id from auth.users where email = 'owner@qnotes.local'), 'us23-forbidden', 'US23 Forbidden', 'us23-forbidden', 'us23-forbidden', '{us23-small}', '85000000-0000-4000-8000-000000000002', 1, gen_random_uuid(), gen_random_uuid()),
  ('85000000-0000-4000-8000-000000000013', (select id from auth.users where email = 'owner@qnotes.local'), 'us23-stale', 'US23 Stale', 'us23-stale', 'us23-stale', '{us23-stale}', '85000000-0000-4000-8000-000000000001', 1, gen_random_uuid(), gen_random_uuid());

insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, content, content_hash, position,
  embedding, embedding_status, embedding_model, embedding_model_version, embedding_input_hash
)
values
  (
    '85000000-0000-4000-8000-000000000021',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '85000000-0000-4000-8000-000000000011',
    'note_chunk', 'us23-small', 'US23 Small', 'us23-small', 'us23-small-hash', 0,
    ('[0,1,' || repeat('0,', 381) || '0]')::extensions.vector,
    'ready', 'gte-small', 'v2', public.qnotes_embedding_input_hash('US23 Small', null, 'us23-small')
  ),
  (
    '85000000-0000-4000-8000-000000000022',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '85000000-0000-4000-8000-000000000012',
    'note_chunk', 'us23-forbidden', 'US23 Forbidden', 'us23-forbidden', 'us23-forbidden-hash', 0,
    ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
    'ready', 'gte-small', 'v2', public.qnotes_embedding_input_hash('US23 Forbidden', null, 'us23-forbidden')
  ),
  (
    '85000000-0000-4000-8000-000000000023',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '85000000-0000-4000-8000-000000000013',
    'note_chunk', 'us23-stale', 'US23 Stale', 'us23-stale', 'us23-stale-hash', 0,
    ('[0,1,' || repeat('0,', 381) || '0]')::extensions.vector,
    'ready', 'gte-small', 'v2', public.qnotes_embedding_input_hash('US23 Stale', null, 'us23-stale')
  );

-- The local regression vectors are deterministic; they verify filtering and
-- freshness guards, while the provider-only probe supplies semantic evidence.
with new_notes as (
  insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, notebook_id, version, last_mutation_id, updated_by_device_id)
  select gen_random_uuid(), (select id from auth.users where email = 'owner@qnotes.local'),
    'us23-large-' || value::text, 'US23 Large ' || value::text, 'us23-large-' || value::text, 'us23-large-' || value::text,
    '{}', '85000000-0000-4000-8000-000000000001', 1, gen_random_uuid(), gen_random_uuid()
  from generate_series(1, 130) as values(value)
  returning id, owner_id, title, slug
)
insert into notesdb.search_documents (
  owner_id, note_id, source_type, source_key, source_title, content, content_hash, position,
  embedding, embedding_status, embedding_model, embedding_model_version, embedding_input_hash
)
select owner_id, id, 'note_chunk', slug, title, title, slug || '-hash', 0,
  ('[0,1,' || repeat('0,', 381) || '0]')::extensions.vector,
  'ready', 'gte-small', 'v2', public.qnotes_embedding_input_hash(title, null, title)
from new_notes;

select is(
  (
    select count(*)::integer
    from public.qnotes_semantic_search_scoped(
      (select id from auth.users where email = 'owner@qnotes.local'),
      'us23-small',
      ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
      10,
      '{"tags":["us23-small"]}'::jsonb,
      0,
      2,
      array['85000000-0000-4000-8000-000000000001']::uuid[],
      false
    )
  ),
  1,
  'small authorized tag subset returns its exact filtered match'
);
select is(
  (
    select count(*)::integer
    from public.qnotes_semantic_search(
      (select id from auth.users where email = 'owner@qnotes.local'),
      'us23-small',
      ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
      10,
      '{"tags":["us23-small"]}'::jsonb,
      0,
      2
    )
  ),
  2,
  'account-wide semantic search uses the recall-scoped implementation'
);
select is(
  (
    select count(*)::integer
    from public.qnotes_semantic_search(
      (select id from auth.users where email = 'owner@qnotes.local'),
      'us23-small',
      ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
      10,
      '{"tags":["us23-small"],"notebookIds":["85000000-0000-4000-8000-000000000001"],"unfiled":true}'::jsonb,
      0,
      2
    )
  ),
  1,
  'combined notebook and unfiled filters retain the requested notebook scope'
);
select ok(
  (
    select not exists (
      select 1
      from public.qnotes_semantic_search_scoped(
        (select id from auth.users where email = 'owner@qnotes.local'),
        'us23-small',
        ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
        10,
        '{"tags":["us23-small"]}'::jsonb,
        0,
        2,
        array['85000000-0000-4000-8000-000000000001']::uuid[],
        false
      )
      where id = '85000000-0000-4000-8000-000000000022'
    )
  ),
  'small filtered results cannot include a forbidden document'
);
select is(
  (
    public.qnotes_measure_tenant_vector_recall(
      (select id from auth.users where email = 'owner@qnotes.local'),
      ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
      '{"tags":["us23-small"]}'::jsonb,
      array['85000000-0000-4000-8000-000000000001']::uuid[],
      false,
      1
    )->>'exactIds'
  ),
  '["85000000-0000-4000-8000-000000000021"]',
  'recall probe exact oracle uses the authorized filtered set'
);

select ok(
  (
    select count(*) > 0
    from public.qnotes_semantic_search_scoped(
      (select id from auth.users where email = 'owner@qnotes.local'),
      'us23-large',
      ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
      1,
      '{}'::jsonb,
      0,
      1,
      array['85000000-0000-4000-8000-000000000001']::uuid[],
      false
    )
  ),
  'large authorized subset remains reachable through HNSW retrieval'
);
select ok(
  case public.qnotes_configure_hnsw_search(false)
    when 'iterative' then current_setting('hnsw.iterative_scan', true) = 'strict_order'
      and current_setting('hnsw.ef_search', true) = '80'
      and current_setting('hnsw.max_scan_tuples', true) = '10000'
      and current_setting('hnsw.scan_mem_multiplier', true) = '1'
    else true
  end,
  'supported pgvector versions use the measured bounded configuration'
);

alter table notesdb.search_documents disable trigger search_documents_prepare_embedding;
update notesdb.search_documents
set content = 'us23-stale-changed', content_hash = 'us23-stale-changed-hash'
where id = '85000000-0000-4000-8000-000000000023';
alter table notesdb.search_documents enable trigger search_documents_prepare_embedding;
select is(
  (
    select count(*)::integer
    from public.qnotes_semantic_search_scoped(
      (select id from auth.users where email = 'owner@qnotes.local'),
      'us23-stale',
      ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
      10,
      '{"tags":["us23-stale"]}'::jsonb,
      0,
      2,
      array['85000000-0000-4000-8000-000000000001']::uuid[],
      false
    )
  ),
  0,
  'stale embedding input hash is excluded from filtered recall'
);

select ok(
  (public.qnotes_configure_hnsw_search(false) in ('iterative', 'ef_search', 'default')),
  'HNSW configuration is version-gated to a supported strategy'
);
select ok(
  (public.qnotes_measure_tenant_vector_recall(
    (select id from auth.users where email = 'owner@qnotes.local'),
    ('[1,0,' || repeat('0,', 381) || '0]')::extensions.vector,
    '{"tags":["us23-small"]}'::jsonb,
    array['85000000-0000-4000-8000-000000000001']::uuid[],
    false,
    1
  ) ? 'recallAtK'),
  'recall probe reports a recall metric'
);

select * from finish();
rollback;
