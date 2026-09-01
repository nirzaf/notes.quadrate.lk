create extension if not exists pg_trgm with schema extensions;

create index if not exists notes_title_trigram_gin_key
  on notesdb.notes using gin (lower(title) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists notes_content_plain_trigram_gin_key
  on notesdb.notes using gin (lower(content_plain) extensions.gin_trgm_ops)
  where deleted_at is null;
create index if not exists search_documents_source_title_trigram_gin_key
  on notesdb.search_documents using gin (lower(source_title) extensions.gin_trgm_ops);
create index if not exists search_documents_source_key_trigram_gin_key
  on notesdb.search_documents using gin (lower(source_key) extensions.gin_trgm_ops);
create index if not exists search_documents_content_trigram_gin_key
  on notesdb.search_documents using gin (lower(content) extensions.gin_trgm_ops);

create or replace function public.qnotes_keyword_search(p_owner_id uuid, p_query text, p_limit integer)
returns table (
  id uuid,
  note_id uuid,
  note_slug text,
  note_title text,
  source_type text,
  source_id uuid,
  source_key text,
  source_title text,
  heading_path text,
  snippet text,
  score double precision,
  keyword_rank integer,
  semantic_rank integer,
  block_key text,
  language text,
  attachment_id uuid
)
language sql
security definer
set search_path = public, extensions
as $$
  with params as (
    select
      lower(trim(p_query)) as normalized_query,
      replace(replace(replace(lower(trim(p_query)), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as like_query,
      websearch_to_tsquery('simple', p_query) as ts_query
  ),
  note_matches as (
    select
      n.id as result_id,
      n.id as result_note_id,
      n.slug as result_note_slug,
      n.title as result_note_title,
      'note_chunk'::text as result_source_type,
      null::uuid as result_source_id,
      ('note:' || n.id::text)::text as result_source_key,
      n.title as result_source_title,
      null::text as result_heading_path,
      case
        when lower(n.content_plain) like '%' || p.like_query || '%' escape E'\\' then left(n.content_plain, 280)
        else left(coalesce(nullif(n.content_plain, ''), n.title), 280)
      end as result_snippet,
      (
        case
          when lower(n.title) = p.normalized_query then 1000000
          when lower(n.title) like p.like_query || '%' escape E'\\' then 900000
          when lower(n.title) like '%' || p.like_query || '%' escape E'\\' then 800000
          when p.ts_query::text <> '' and to_tsvector('simple', n.title) @@ p.ts_query then 700000
          else 0
        end
        + case
          when lower(n.content_plain) like '%' || p.like_query || '%' escape E'\\' then 200000
          when p.ts_query::text <> '' and to_tsvector('simple', n.content_plain) @@ p.ts_query then 100000
          else 0
        end
        + case
          when p.ts_query::text <> '' then (ts_rank_cd(to_tsvector('simple', n.title), p.ts_query) * 1000)::integer
          else 0
        end
      )::double precision as result_score,
      null::text as result_block_key,
      null::text as result_language,
      null::uuid as result_attachment_id
    from notesdb.notes n
    cross join params p
    where n.owner_id = p_owner_id
      and n.deleted_at is null
      and (
        lower(n.title) like '%' || p.like_query || '%' escape E'\\'
        or lower(n.content_plain) like '%' || p.like_query || '%' escape E'\\'
        or (p.ts_query::text <> '' and (
          to_tsvector('simple', n.title) @@ p.ts_query
          or to_tsvector('simple', n.content_plain) @@ p.ts_query
        ))
      )
  ),
  document_matches as (
    select
      d.id as result_id,
      d.note_id as result_note_id,
      n.slug as result_note_slug,
      n.title as result_note_title,
      d.source_type as result_source_type,
      coalesce(b.id, d.source_id) as result_source_id,
      d.source_key as result_source_key,
      d.source_title as result_source_title,
      d.heading_path as result_heading_path,
      case
        when lower(d.content) like '%' || p.like_query || '%' escape E'\\' then left(d.content, 280)
        else left(coalesce(nullif(d.source_title, ''), d.content), 280)
      end as result_snippet,
      (
        case
          when lower(d.source_title) like '%' || p.like_query || '%' escape E'\\' then 40000
          when lower(d.source_key) like '%' || p.like_query || '%' escape E'\\' then 30000
          when lower(d.content) like '%' || p.like_query || '%' escape E'\\' then 20000
          when p.ts_query::text <> '' and d.search_vector @@ p.ts_query then 10000
          else 0
        end
      )::double precision as result_score,
      b.block_key as result_block_key,
      b.language as result_language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as result_attachment_id
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id
      and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block')
      and b.block_key = d.source_key
    cross join params p
    where d.owner_id = p_owner_id
      and d.source_type <> 'note_chunk'
      and (
        lower(d.source_title) like '%' || p.like_query || '%' escape E'\\'
        or lower(d.source_key) like '%' || p.like_query || '%' escape E'\\'
        or lower(d.content) like '%' || p.like_query || '%' escape E'\\'
        or (p.ts_query::text <> '' and d.search_vector @@ p.ts_query)
      )
  ),
  combined as (
    select * from note_matches
    union all
    select * from document_matches
  ),
  numbered as (
    select combined.*, row_number() over (order by result_score desc, result_id)::integer as result_rank
    from combined
  )
  select result_id, result_note_id, result_note_slug, result_note_title, result_source_type, result_source_id,
    result_source_key, result_source_title, result_heading_path, result_snippet, result_score, result_rank,
    null::integer, result_block_key, result_language, result_attachment_id
  from numbered
  order by result_score desc, result_id
  limit greatest(1, least(p_limit, 50));
$$;
