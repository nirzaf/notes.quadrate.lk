begin;
select plan(18);

select ok(exists (
  select 1 from information_schema.columns
  where table_schema = 'notesdb' and table_name = 'search_documents' and column_name = 'block_key'
), 'search documents persist the parent block identity');

select is(
  public.qnotes_embedding_input('Title', 'Heading', 'Body'),
  'Title' || chr(10) || chr(10) || 'Heading' || chr(10) || chr(10) || 'Body',
  'embedding input uses the canonical title heading and body separators'
);
select is(
  public.qnotes_embedding_input_hash('Title', 'Heading', 'Body'),
  encode(extensions.digest(
    convert_to('v3', 'utf8') || decode('00', 'hex') ||
      convert_to('Title' || chr(10) || chr(10) || 'Heading' || chr(10) || chr(10) || 'Body', 'utf8'),
    'sha256'
  ), 'hex'),
  'embedding input hashes include the v3 input identity'
);

select ok(
  (select count(*) > 1
   from public.qnotes_embedding_content_chunks(
     repeat('長', 100), repeat('見出し', 100), repeat('x', 2000) || chr(10) || 'US25_TAIL_FACT'
   )),
  'oversized content is split into multiple deterministic chunks'
);
select is(
  (select content
   from public.qnotes_embedding_content_chunks(
     repeat('長', 100), repeat('見出し', 100), repeat('x', 2000) || chr(10) || 'US25_TAIL_FACT'
   )
   order by chunk_index desc
   limit 1),
  'US25_TAIL_FACT',
  'the tail fact remains in the final chunk'
);
select ok(
  (select bool_and(
     octet_length(public.qnotes_embedding_input(repeat('長', 100), repeat('見出し', 100), content)) <= 496
   )
   from public.qnotes_embedding_content_chunks(
     repeat('長', 100), repeat('見出し', 100), repeat('x', 2000) || chr(10) || 'US25_TAIL_FACT'
   )),
  'every SQL chunk stays inside the conservative provider input budget'
);
select ok(
  (select count(*) > 1
   from public.qnotes_embedding_content_chunks('Title', null, repeat('x', 200000))),
  'a very long single line is chunked with bounded memory movement'
);

with input as (
  select jsonb_build_array(jsonb_build_object(
    'sourceType', 'code_block',
    'sourceKey', 'block-1',
    'sourceTitle', repeat('Long title ', 40),
    'headingPath', 'Code',
    'content', repeat('line', 500) || chr(10) || 'US25_TAIL_FACT',
    'contentHash', 'original-hash',
    'position', 2
  )) as documents
), runs as (
  select public.qnotes_expand_embedding_documents(documents) as expanded
  from input, generate_series(1, 2)
)
select is((select count(distinct expanded) from runs), 1::bigint, 'expanded document identities are deterministic');
select ok(
  (select jsonb_array_length(public.qnotes_expand_embedding_documents(documents)) > 1 from (
    select jsonb_build_array(jsonb_build_object(
      'sourceType', 'code_block', 'sourceKey', 'block-1',
      'sourceTitle', repeat('Long title ', 40), 'headingPath', 'Code',
      'content', repeat('line', 500) || chr(10) || 'US25_TAIL_FACT',
      'contentHash', 'original-hash', 'position', 2
    )) as documents
  ) input),
  'expanded oversized documents contain multiple search documents'
);
select is(
  (select value->>'blockKey'
   from jsonb_array_elements(public.qnotes_expand_embedding_documents(jsonb_build_array(jsonb_build_object(
     'sourceType', 'code_block', 'sourceKey', 'block-1',
     'sourceTitle', repeat('Long title ', 40), 'headingPath', 'Code',
     'content', repeat('line', 500), 'contentHash', 'original-hash',
     'position', 2147483647
   ))))
   limit 1),
  'block-1',
  'expanded code documents retain the canonical block identity'
);
select ok(
  (select bool_and((value->>'position')::integer between 0 and 2147483647)
   from jsonb_array_elements(public.qnotes_expand_embedding_documents(jsonb_build_array(jsonb_build_object(
     'sourceType', 'code_block', 'sourceKey', 'block-1',
     'sourceTitle', repeat('Long title ', 40), 'headingPath', 'Code',
     'content', repeat('line', 500), 'contentHash', 'original-hash',
     'position', 2147483647
   )))) ),
  'expanded positions stay inside PostgreSQL integer range'
);
select ok(
  (select bool_and(value->>'sourceKey' like 'block-1:chunk:%')
   from jsonb_array_elements(public.qnotes_expand_embedding_documents(jsonb_build_array(jsonb_build_object(
     'sourceType', 'code_block', 'sourceKey', 'block-1',
     'sourceTitle', repeat('Long title ', 40), 'headingPath', 'Code',
     'content', repeat('line', 500) || chr(10) || 'US25_TAIL_FACT',
     'contentHash', 'original-hash', 'position', 2
   ))))
   where value->>'sourceType' = 'code_block'),
  'expanded code documents carry versioned deterministic chunk keys'
);
insert into notesdb.notes (
  id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id
) values (
  'a2500000-0000-4000-8000-000000000001',
  (select id from auth.users where email = 'owner@qnotes.local'),
  'us25-block-provenance', 'US25 block provenance', '', '', '{}', 1, gen_random_uuid(), gen_random_uuid()
);
select public.qnotes_sync_note_content(
  'a2500000-0000-4000-8000-000000000001',
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(jsonb_build_object(
    'blockKey', 'block-1', 'blockType', 'code', 'title', 'SQL', 'language', 'sql',
    'content', repeat('line ', 500), 'position', 0, 'copyable', true, 'contentHash', 'us25-block-hash'
  )),
  jsonb_build_array(jsonb_build_object(
    'sourceType', 'code_block', 'sourceKey', 'block-1', 'sourceTitle', 'SQL',
    'content', repeat('line ', 500), 'contentHash', 'us25-block-hash', 'position', 0
  ))
);
select ok(
  (select count(*) > 1 and bool_and(block_key = 'block-1')
   from notesdb.search_documents
   where note_id = 'a2500000-0000-4000-8000-000000000001'
     and source_type = 'code_block'),
  'oversized code chunks retain their parent block for language-filtered search'
);
with input as (
  select jsonb_build_array(
    jsonb_build_object(
      'sourceType', 'note_chunk', 'sourceKey', 'first', 'sourceTitle', 'First',
      'content', repeat('x', 5000), 'position', 2
    ),
    jsonb_build_object(
      'sourceType', 'note_chunk', 'sourceKey', 'second', 'sourceTitle', 'Second',
      'content', 'later document', 'position', 3
    )
  ) as documents
), expanded as (
  select public.qnotes_expand_embedding_documents(documents) as value
  from input
), rows as (
  select item->>'sourceKey' as source_key, (item->>'position')::integer as position
  from expanded cross join lateral jsonb_array_elements(expanded.value) as items(item)
)
select ok(
  (select count(*) = count(distinct position) from rows)
    and (select max(position) from rows where source_key like 'first:chunk:%')
      < (select min(position) from rows where source_key = 'second'),
  'expanded chunks occupy distinct positions before the next document'
);
select ok(
  public.qnotes_embedding_input_hash('Title', 'Heading', 'Body') <> encode(extensions.digest(
    'Title' || chr(10) || chr(10) || 'Heading' || chr(10) || chr(10) || 'Body', 'sha256'
  ), 'hex'),
  'v3 input hashing does not reuse the pre-version hash'
);

select has_function('public', 'qnotes_requeue_embedding_generation', array['integer'], 'bounded embedding requeue function is present');
select throws_ok(
  $$select public.qnotes_requeue_embedding_generation(0)$$,
  '22023',
  'embedding generation limit must be between 1 and 1000',
  'embedding requeue rejects an unbounded or empty batch'
);
select ok(
  not has_function_privilege('anon', 'public.qnotes_requeue_embedding_generation(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.qnotes_requeue_embedding_generation(integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.qnotes_requeue_embedding_generation(integer)', 'EXECUTE'),
  'embedding requeue is restricted to service_role'
);

select * from finish();
rollback;
