begin;
select plan(7);

select ok(exists (
  select 1 from pg_indexes
  where schemaname = 'notesdb'
    and indexname = 'search_documents_owner_source_key_lower_key'
    and indexdef like '%lower(source_key)%'
), 'exact source identifiers have an owner-scoped normalized index');

select ok(exists (
  select 1 from pg_indexes
  where schemaname = 'notesdb'
    and indexname = 'search_documents_owner_source_title_lower_key'
    and indexdef like '%lower(source_title)%'
), 'exact source titles have an owner-scoped normalized index');

select ok(exists (
  select 1 from pg_indexes
  where schemaname = 'notesdb'
    and indexname = 'search_documents_source_key_trigram_gin_key'
    and indexdef like '%gin_trgm_ops%'
), 'fuzzy source identifiers keep a trigram index');

insert into notesdb.notes (
  id, owner_id, slug, title, content_markdown, content_plain, tags, version,
  last_mutation_id, updated_by_device_id
) values
  ('a1080000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'search-index-wildcard-target', 'Wildcard target', '', '', '{}', 1, gen_random_uuid(), gen_random_uuid()),
  ('a1080000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'search-index-wildcard-overmatch', 'Wildcard overmatch', '', '', '{}', 1, gen_random_uuid(), gen_random_uuid()),
  ('a1080000-0000-4000-8000-000000000003', (select id from auth.users where email = 'owner@qnotes.local'), 'search-index-short-one', 'Short query one', '', '', '{}', 1, gen_random_uuid(), gen_random_uuid()),
  ('a1080000-0000-4000-8000-000000000004', (select id from auth.users where email = 'owner@qnotes.local'), 'search-index-short-two', 'Short query two', '', '', '{}', 1, gen_random_uuid(), gen_random_uuid()),
  ('a1080000-0000-4000-8000-000000000005', (select id from auth.users where email = 'owner@qnotes.local'), 'search-index-short-three', 'Short query three', '', '', '{}', 1, gen_random_uuid(), gen_random_uuid());

insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, content,
  content_hash, position
) values
  ('b1080000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'a1080000-0000-4000-8000-000000000001', 'note_chunk', '%%%__', 'Literal wildcard fixture', 'wildcard content', 'search-index-wildcard-target', 0),
  ('b1080000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'a1080000-0000-4000-8000-000000000002', 'note_chunk', 'ordinary-key', 'ordinary title', 'ordinary content', 'search-index-wildcard-overmatch', 0),
  ('b1080000-0000-4000-8000-000000000003', (select id from auth.users where email = 'owner@qnotes.local'), 'a1080000-0000-4000-8000-000000000003', 'note_chunk', 'short-at-one', 'Short one', 'contains @@ marker one', 'search-index-short-one', 0),
  ('b1080000-0000-4000-8000-000000000004', (select id from auth.users where email = 'owner@qnotes.local'), 'a1080000-0000-4000-8000-000000000004', 'note_chunk', 'short-at-two', 'Short two', 'contains @@ marker two', 'search-index-short-two', 0),
  ('b1080000-0000-4000-8000-000000000005', (select id from auth.users where email = 'owner@qnotes.local'), 'a1080000-0000-4000-8000-000000000005', 'note_chunk', 'short-at-three', 'Short three', 'contains @@ marker three', 'search-index-short-three', 0);

select is(
  (select array_agg(source_key order by source_key) from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), '%%%__', 20)),
  array['%%%__']::text[],
  'wildcard characters are matched literally'
);

select is(
  (select count(*)::integer from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), '@', 1)),
  1,
  'one-character substring searches honor the result limit'
);

select is(
  (select count(*)::integer from public.qnotes_keyword_search((select id from auth.users where email = 'owner@qnotes.local'), '@@', 2)),
  2,
  'two-character substring searches honor the result limit'
);

analyze notesdb.search_documents;
create temporary table search_index_explain (lookup text, plan jsonb) on commit drop;
do $$
declare
  source_key_plan jsonb;
  source_title_plan jsonb;
begin
  set local enable_seqscan = off;
  execute $query$
    explain (format json)
    select d.id
    from notesdb.search_documents d
    where d.owner_id = (select id from auth.users where email = 'owner@qnotes.local')
      and lower(d.source_key) = '%%%__'
  $query$ into source_key_plan;
  execute $query$
    explain (format json)
    select d.id
    from notesdb.search_documents d
    where d.owner_id = (select id from auth.users where email = 'owner@qnotes.local')
      and lower(d.source_title) = 'literal wildcard fixture'
  $query$ into source_title_plan;
  insert into search_index_explain values ('source_key', source_key_plan), ('source_title', source_title_plan);
end;
$$;

select ok((
  (select jsonb_path_exists(plan, '$.**."Index Name" ? (@ == "search_documents_owner_source_key_lower_key")') from search_index_explain where lookup = 'source_key')
    and (select jsonb_path_exists(plan, '$.**."Index Name" ? (@ == "search_documents_owner_source_title_lower_key")') from search_index_explain where lookup = 'source_title')
), 'exact source-key/title lookup uses both owner-scoped btree indexes');

select * from finish();
rollback;
