-- Run this file against the local database after seeding a representative
-- corpus. The seeded local evaluation owner is resolved in each query so the
-- plans can run in CI without copying an account identifier into this file.
-- This file intentionally records no unmeasured production claim.

do $$
declare
  evaluation_owner uuid;
  operations_notebook uuid;
  ready_documents integer;
begin
  select id into evaluation_owner from auth.users where email = 'hermes-evaluation@qnotes.local';
  if evaluation_owner is null then
    raise exception 'search plan corpus is missing hermes-evaluation@qnotes.local';
  end if;
  if not exists (
    select 1 from notesdb.notes
    where owner_id = evaluation_owner
      and lower(title) = 'erpnext production rollback'
      and lower(slug) = 'erpnext-production-rollback'
      and deleted_at is null
  ) then
    raise exception 'search plan corpus is missing the ERPNext Production Rollback note';
  end if;
  select id into operations_notebook
  from notesdb.notebooks
  where owner_id = evaluation_owner and lower(name) = 'operations'
  order by id
  limit 1;
  if operations_notebook is null then
    raise exception 'search plan corpus is missing the Operations notebook';
  end if;
  select count(*) into ready_documents
  from notesdb.search_documents
  where owner_id = evaluation_owner
    and embedding_status = 'ready'
    and embedding_model = 'gte-small'
    and embedding_model_version = 'v2'
    and embedding_mode = 'synthetic-test-v1'
    and embedding is not null;
  if ready_documents = 0 then
    raise exception 'search plan corpus has no ready v2 synthetic vectors';
  end if;
end $$;

-- Exact title/slug and note ownership path.
explain (analyze, buffers, settings, format json)
select d.id, d.note_id
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and n.owner_id = d.owner_id
  and n.deleted_at is null
  and (lower(n.title) = 'erpnext production rollback' or lower(n.slug) = 'erpnext-production-rollback')
order by d.id
limit 51;

-- GIN full-text search path used by keyword_candidates.
explain (analyze, buffers, settings, format json)
select d.id, ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', 'rollback production')) as rank
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and d.search_vector @@ websearch_to_tsquery('simple', 'rollback production')
order by rank desc, d.id
limit 51;

-- Exact source identifier path used by metadata and block lookups.
explain (analyze, buffers, settings, format json)
select d.id, d.note_id
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = '00000000-0000-4000-8000-000000000000'::uuid
  and lower(d.source_key) = 'deploy-key'
order by d.id
limit 51;

-- Trigram path for misspellings and partial titles.
explain (analyze, buffers, settings, format json)
select d.id, greatest(similarity(lower(d.source_title), 'erp nxt production rollbak'), similarity(lower(d.content), 'erp nxt production rollbak')) as similarity
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and (lower(d.source_title) % 'erp nxt production rollbak' or lower(d.content) % 'erp nxt production rollbak')
order by similarity desc, d.id
limit 51;

-- Unfiltered approximate HNSW path. The vector is a valid 384-dimensional
-- query placeholder; use the evaluator's query vector for a measured run.
explain (analyze, buffers, settings, format json)
select d.id, d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384) as distance
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and d.embedding_status = 'ready'
  and d.embedding_model = 'gte-small'
  and d.embedding_model_version = 'v2'
  and d.embedding_mode = 'synthetic-test-v1'
  and d.embedding is not null
order by d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384), d.id
limit 51;

-- Filtered HNSW path with a notebook constraint.
explain (analyze, buffers, settings, format json)
select d.id, d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384) as distance
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and n.notebook_id = (select id from notesdb.notebooks where owner_id = d.owner_id and lower(name) = 'operations' order by id limit 1)
  and d.embedding_status = 'ready'
  and d.embedding_model = 'gte-small'
  and d.embedding_model_version = 'v2'
  and d.embedding_mode = 'synthetic-test-v1'
  and d.embedding is not null
order by d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384), d.id
limit 51;

-- Tag-filtered HNSW path used by semantic search.
explain (analyze, buffers, settings, format json)
select d.id, d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384) as distance
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and n.tags @> array['operations']::text[]
  and d.embedding_status = 'ready'
  and d.embedding_model = 'gte-small'
  and d.embedding_model_version = 'v2'
  and d.embedding_mode = 'synthetic-test-v1'
  and d.embedding is not null
order by d.embedding <#> ('[' || repeat('0,', 383) || '0]')::extensions.vector(384), d.id
limit 51;

-- Filtered keyword path with the tags GIN predicate applied before ranking.
explain (analyze, buffers, settings, format json)
select d.id, n.tags
from notesdb.search_documents d
join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
where d.owner_id = (select id from auth.users where email = 'hermes-evaluation@qnotes.local')
  and n.tags @> array['operations']::text[]
  and d.search_vector @@ websearch_to_tsquery('simple', 'release')
order by ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', 'release')) desc, d.id
limit 51;

-- Full hybrid function path. Inspect its inner keyword/semantic candidate
-- counts and whether the bounded CTEs are materialized as expected.
explain (analyze, buffers, settings, format json)
select *
from public.qnotes_hybrid_search(
  (select id from auth.users where email = 'hermes-evaluation@qnotes.local'),
  'ERPNext Production Rollback',
  ('[' || repeat('0,', 383) || '0]')::extensions.vector(384),
  50,
  60,
  jsonb_build_object('embeddingMode', 'synthetic-test-v1'),
  0,
  2
);
