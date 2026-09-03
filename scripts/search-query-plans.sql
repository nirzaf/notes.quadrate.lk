-- Run against a database with a representative corpus after applying all
-- migrations. Replace the UUID and query values before collecting plans.
explain (analyze, buffers, format json)
select * from public.qnotes_keyword_search(
  '00000000-0000-4000-8000-000000000000'::uuid,
  'rollback production',
  21,
  '{"tags":["operations"],"unfiled":false}'::jsonb,
  0,
  2
);

-- The semantic plan should use the HNSW embedding index while applying the
-- owner, active-note, model/version, hash, and metadata filters.
explain (analyze, buffers, format json)
select * from public.qnotes_semantic_search(
  '00000000-0000-4000-8000-000000000000'::uuid,
  'rollback production',
  ('[' || repeat('0,', 383) || '0]')::extensions.vector(384),
  21,
  '{}'::jsonb,
  0,
  2
);
