-- Exact identifier/title lookups use the same owner and normalized expressions
-- as the keyword RPC. Existing trigram and full-text indexes cover fuzzy and
-- token searches; these btree indexes avoid scanning exact source identities.
create index if not exists search_documents_owner_source_key_lower_key
  on notesdb.search_documents (owner_id, lower(source_key));
create index if not exists search_documents_owner_source_title_lower_key
  on notesdb.search_documents (owner_id, lower(source_title));

-- Keep the fuzzy channel index-supported for normal terms. One- and two-
-- character queries retain the substring fallback because pg_trgm cannot
-- produce useful trigrams for them.
create or replace function public.qnotes_keyword_search(
  p_owner_id uuid,
  p_query text,
  p_limit integer,
  p_filters jsonb,
  p_offset integer,
  p_max_per_note integer
) returns table (
  id uuid, note_id uuid, note_slug text, note_title text, source_type text,
  source_id uuid, source_key text, source_title text, heading_path text,
  snippet text, score double precision, keyword_rank integer,
  semantic_rank integer, block_key text, language text, attachment_id uuid
)
language sql
security definer
set search_path = public, extensions
as $$
  with params as (
    select
      lower(btrim(coalesce(p_query, ''))) as normalized_query,
      replace(replace(replace(lower(btrim(coalesce(p_query, ''))), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as like_query,
      websearch_to_tsquery('simple', coalesce(p_query, '')) as ts_query,
      greatest(1, least(coalesce(p_limit, 21), 1000)) as result_limit,
      greatest(0, coalesce(p_offset, 0)) as result_offset,
      greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit
  ),
  filter_values as (
    select
      coalesce((select array_agg(item::uuid) from jsonb_array_elements_text(coalesce(p_filters->'notebookIds', '[]'::jsonb)) as items(item)), '{}'::uuid[]) as notebook_ids,
      coalesce((select array_agg(item) from jsonb_array_elements_text(coalesce(p_filters->'tags', '[]'::jsonb)) as items(item)), '{}'::text[]) as tags,
      coalesce((select array_agg(item) from jsonb_array_elements_text(coalesce(p_filters->'sourceTypes', '[]'::jsonb)) as items(item)), '{}'::text[]) as source_types,
      coalesce((select array_agg(lower(item)) from jsonb_array_elements_text(coalesce(p_filters->'languages', '[]'::jsonb)) as items(item)), '{}'::text[]) as languages,
      nullif(p_filters->>'updatedAfter', '')::timestamptz as updated_after,
      coalesce((p_filters->>'unfiled')::boolean, false) as unfiled
  ),
  base as not materialized (
    select
      d.id, d.note_id, n.slug as note_slug, n.title as note_title, d.source_type,
      coalesce(b.id, d.source_id) as source_id, d.source_key, d.source_title,
      d.heading_path, d.content, d.search_vector, b.block_key, b.language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as attachment_id,
      case d.source_type when 'code_block' then 0 when 'copy_block' then 1 when 'note_metadata' then 2 when 'note_chunk' then 3 else 4 end as source_priority
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
    cross join filter_values f
    where d.owner_id = p_owner_id
      and (d.embedding is null or d.embedding_mode = coalesce(nullif(p_filters->>'embeddingMode', ''), 'provider'))
      and (cardinality(f.notebook_ids) = 0 or n.notebook_id = any(f.notebook_ids))
      and (cardinality(f.tags) = 0 or n.tags @> f.tags)
      and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
      and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
      and (f.updated_after is null or n.updated_at > f.updated_after)
      and (not f.unfiled or n.notebook_id is null)
  ),
  exact_candidates as (
    select b.id, row_number() over (order by b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where (b.source_type = 'note_metadata' and lower(b.note_slug) = p.normalized_query)
       or lower(b.source_key) = p.normalized_query
       or lower(coalesce(b.block_key, '')) = p.normalized_query
  ),
  title_candidates as (
    select b.id, row_number() over (order by b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where (b.source_type = 'note_metadata' and lower(b.note_title) = p.normalized_query)
       or (b.source_type in ('copy_block', 'code_block', 'attachment_chunk') and lower(b.source_title) = p.normalized_query)
  ),
  fts_candidates as (
    select b.id, row_number() over (order by ts_rank_cd(b.search_vector, p.ts_query) desc, b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p where b.search_vector @@ p.ts_query
  ),
  trigram_candidates as (
    select b.id, row_number() over (order by greatest(similarity(lower(b.source_title), p.normalized_query), similarity(lower(b.source_key), p.normalized_query), similarity(lower(b.content), p.normalized_query)) desc, b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where lower(b.source_title) % p.normalized_query or lower(b.source_key) % p.normalized_query
       or lower(b.content) % p.normalized_query
       or (length(p.normalized_query) < 3 and (
         position(p.normalized_query in lower(coalesce(b.source_title, ''))) > 0
         or position(p.normalized_query in lower(coalesce(b.source_key, ''))) > 0
         or position(p.normalized_query in lower(coalesce(b.content, ''))) > 0
       ))
       or lower(coalesce(b.source_title, '')) like '%' || p.like_query || '%' escape E'\\'
       or lower(coalesce(b.source_key, '')) like '%' || p.like_query || '%' escape E'\\'
       or lower(coalesce(b.content, '')) like '%' || p.like_query || '%' escape E'\\'
  ),
  keyword_scores as (
    select id, sum(weight / (60.0 + channel_rank))::double precision as score
    from (
      select id, channel_rank, 2.0::double precision as weight from exact_candidates
      union all select id, channel_rank, 1.5::double precision from title_candidates
      union all select id, channel_rank, 1.2::double precision from fts_candidates
      union all select id, channel_rank, 0.8::double precision from trigram_candidates
    ) channels group by id
  ),
  ranked as (
    select b.*, k.score, row_number() over (order by k.score desc, b.source_priority, b.id)::integer as keyword_rank
    from keyword_scores k join base b on b.id = k.id
  ),
  per_note as (
    select ranked.*, row_number() over (partition by note_id order by score desc, source_priority, id)::integer as note_rank
    from ranked
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, public.qnotes_search_snippet(content, p_query),
    score, keyword_rank, null::integer, block_key, language, attachment_id
  from per_note cross join params p
  where note_rank <= p.note_limit
  order by score desc, source_priority, id
  limit (select result_limit from params) offset (select result_offset from params);
$$;

create or replace function public.qnotes_keyword_search(p_owner_id uuid, p_query text, p_limit integer)
returns table (
  id uuid, note_id uuid, note_slug text, note_title text, source_type text,
  source_id uuid, source_key text, source_title text, heading_path text,
  snippet text, score double precision, keyword_rank integer,
  semantic_rank integer, block_key text, language text, attachment_id uuid
)
language sql
security definer
set search_path = public, extensions
as $$
  select * from public.qnotes_keyword_search(p_owner_id, p_query, p_limit, '{}'::jsonb, 0, 2);
$$;
