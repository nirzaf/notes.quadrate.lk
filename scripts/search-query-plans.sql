-- Run this file against the local database after seeding a representative
-- corpus. Replace the UUID with the seeded owner and inspect the JSON plans;
-- this file intentionally records no unmeasured production claim.

-- Exact title/slug and note ownership path.
explain (analyze, buffers, settings, format json)
select d.id, d.note_id
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and n.owner_id = d.owner_id
  and n.deleted_at is null
  and (lower(n.title) = 'rollback production' or lower(n.slug) = 'rollback-production')
order by d.id
limit 51;

-- GIN full-text search path used by keyword_candidates.
explain (analyze, buffers, settings, format json)
select d.id, ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', 'rollback production')) as rank
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and d.search_vector @@ websearch_to_tsquery('simple', 'rollback production')
order by rank desc, d.id
limit 51;

-- Trigram path for misspellings and partial titles.
explain (analyze, buffers, settings, format json)
select d.id, greatest(similarity(lower(d.source_title), 'erp nxt production rollbak'), similarity(lower(d.content), 'erp nxt production rollbak')) as similarity
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and (lower(d.source_title) % 'erp nxt production rollbak' or lower(d.content) % 'erp nxt production rollbak')
order by similarity desc, d.id
limit 51;

-- Unfiltered approximate HNSW path. The vector is a valid 384-dimensional
-- query placeholder; use the evaluator's query vector for a measured run.
explain (analyze, buffers, settings, format json)
select d.id, d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384) as distance
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and d.embedding_status = 'ready'
  and d.embedding_model = 'gte-small'
  and d.embedding_model_version = 'v2'
  and d.embedding is not null
order by d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384), d.id
limit 51;

-- Filtered HNSW path with a notebook constraint.
explain (analyze, buffers, settings, format json)
select d.id, d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384) as distance
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and n.notebook_id = '00000000-0000-4000-8000-000000000001'::uuid
  and d.embedding_status = 'ready'
  and d.embedding_model = 'gte-small'
  and d.embedding_model_version = 'v2'
  and d.embedding is not null
order by d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384), d.id
limit 51;

-- Tag-filtered HNSW path used by semantic search.
explain (analyze, buffers, settings, format json)
select d.id, d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384) as distance
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and n.tags @> array['operations']::text[]
  and d.embedding_status = 'ready'
  and d.embedding_model = 'gte-small'
  and d.embedding_model_version = 'v2'
  and d.embedding is not null
order by d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384), d.id
limit 51;

-- Filtered keyword path with the tags GIN predicate applied before ranking.
explain (analyze, buffers, settings, format json)
select d.id, n.tags
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and n.tags @> array['operations']::text[]
  and d.search_vector @@ websearch_to_tsquery('simple', 'release')
order by ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', 'release')) desc, d.id
limit 51;

-- Full hybrid function path. Inspect its inner keyword/semantic candidate
-- counts and whether the bounded CTEs are materialized as expected.
explain (analyze, buffers, settings, format json)
select *
from public.qnotes_hybrid_search(
  '00000000-0000-4000-8000-000000000000'::uuid,
  'rollback production',
  ('[' || repeat('0,', 383) || '0]')::extensions.vector(384),
  50,
  60,
  '{}'::jsonb,
  0,
  2
);
