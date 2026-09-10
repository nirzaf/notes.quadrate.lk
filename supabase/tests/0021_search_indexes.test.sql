begin;
select plan(5);

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

select ok((select pg_get_functiondef('public.qnotes_keyword_search(uuid,text,integer,jsonb,integer,integer)'::regprocedure) like '%like_query%'), 'keyword fuzzy matching escapes wildcard characters');
select ok((select pg_get_functiondef('public.qnotes_keyword_search(uuid,text,integer,jsonb,integer,integer)'::regprocedure) like '%length(p.normalized_query) < 3%'), 'short queries retain a bounded substring compatibility path');

select * from finish();
rollback;
