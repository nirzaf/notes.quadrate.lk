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
  with ranked as (
    select d.*, n.slug, n.title as note_title,
      ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', p_query))::double precision
      + case when lower(d.source_key) = lower(p_query) then 5 else 0 end
      + case when position(lower(p_query) in lower(d.source_key)) > 0 then 3 else 0 end
      + case when lower(coalesce(b.block_key, '')) = lower(p_query) then 4 else 0 end
      + case when position(lower(p_query) in lower(coalesce(b.block_key, ''))) > 0 then 2 else 0 end
      + case when lower(n.title) like '%' || lower(p_query) || '%' then 2 else 0 end
      + case when lower(d.content) like '%' || lower(p_query) || '%' then 1 else 0 end as rank_score,
      b.id as joined_block_id,
      b.block_key as joined_block_key,
      b.language as joined_language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as joined_attachment_id
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
    where d.owner_id = p_owner_id
      and (d.search_vector @@ websearch_to_tsquery('simple', p_query)
        or position(lower(p_query) in lower(d.source_key)) > 0
        or position(lower(p_query) in lower(coalesce(b.block_key, ''))) > 0)
  ), numbered as (
    select ranked.*, row_number() over (order by ranked.rank_score desc, ranked.id)::integer as row_number from ranked
  )
  select id, note_id, slug, note_title, source_type, coalesce(joined_block_id, source_id), source_key, source_title, heading_path,
    ts_headline('simple', content, websearch_to_tsquery('simple', p_query), 'MaxWords=35,MinWords=8'),
    rank_score, row_number, null::integer, joined_block_key, joined_language, joined_attachment_id
  from numbered
  order by rank_score desc, id
  limit greatest(1, least(p_limit, 50));
$$;

create or replace function public.qnotes_semantic_search(p_owner_id uuid, p_embedding extensions.vector(384), p_limit integer)
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
  with ranked as (
    select d.*, n.slug, n.title as note_title,
      (-(d.embedding <#> p_embedding))::double precision as rank_score,
      b.id as joined_block_id,
      b.block_key as joined_block_key,
      b.language as joined_language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as joined_attachment_id
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
    where d.owner_id = p_owner_id and d.embedding_status = 'ready' and d.embedding is not null
  ), numbered as (
    select ranked.*, row_number() over (order by rank_score desc, id)::integer as row_number from ranked
  )
  select id, note_id, slug, note_title, source_type, coalesce(joined_block_id, source_id), source_key, source_title, heading_path,
    left(content, 280), rank_score, null::integer, row_number, joined_block_key, joined_language, joined_attachment_id
  from numbered
  order by rank_score desc, id
  limit greatest(1, least(p_limit, 50));
$$;

create or replace function public.qnotes_hybrid_search(p_owner_id uuid, p_query text, p_embedding extensions.vector(384), p_limit integer, p_rrf_k integer default 60)
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
  with keyword as (select k.* from public.qnotes_keyword_search(p_owner_id, p_query, 50) k),
  semantic as (select s.* from public.qnotes_semantic_search(p_owner_id, p_embedding, 50) s),
  combined as (
    select coalesce(k.id, s.id) as result_id,
      coalesce(k.note_id, s.note_id) as result_note_id,
      coalesce(k.note_slug, s.note_slug) as result_note_slug,
      coalesce(k.note_title, s.note_title) as result_note_title,
      coalesce(k.source_type, s.source_type) as result_source_type,
      coalesce(k.source_id, s.source_id) as result_source_id,
      coalesce(k.source_key, s.source_key) as result_source_key,
      coalesce(k.source_title, s.source_title) as result_source_title,
      coalesce(k.heading_path, s.heading_path) as result_heading_path,
      coalesce(k.snippet, s.snippet) as result_snippet,
      (coalesce(1.0 / (p_rrf_k + k.keyword_rank), 0) + coalesce(1.0 / (p_rrf_k + s.semantic_rank), 0))::double precision as result_score,
      k.keyword_rank as result_keyword_rank,
      s.semantic_rank as result_semantic_rank,
      coalesce(k.block_key, s.block_key) as result_block_key,
      coalesce(k.language, s.language) as result_language,
      coalesce(k.attachment_id, s.attachment_id) as result_attachment_id
    from keyword k full join semantic s on s.id = k.id
  )
  select result_id, result_note_id, result_note_slug, result_note_title, result_source_type, result_source_id, result_source_key, result_source_title, result_heading_path, result_snippet, result_score, result_keyword_rank, result_semantic_rank, result_block_key, result_language, result_attachment_id
  from combined order by result_score desc, result_id
  limit greatest(1, least(p_limit, 50));
$$;

create or replace function public.qnotes_read_queue(p_queue_name text, p_visibility_seconds integer, p_batch_size integer)
returns table (message_id bigint, read_count integer, message jsonb)
language sql
security definer
set search_path = public, extensions
as $$
  select msg_id, read_ct, message from pgmq.read(p_queue_name, p_visibility_seconds, p_batch_size);
$$;

create or replace function public.qnotes_delete_queue_message(p_queue_name text, p_message_id bigint)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select pgmq.delete(p_queue_name, p_message_id);
$$;

create or replace function public.qnotes_archive_queue_message(p_queue_name text, p_message_id bigint)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select pgmq.archive(p_queue_name, p_message_id);
$$;

select pgmq.create('note-embeddings');
select pgmq.create('attachment-processing');

revoke all on function public.qnotes_keyword_search(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.qnotes_semantic_search(uuid, extensions.vector, integer) from public, anon, authenticated;
revoke all on function public.qnotes_hybrid_search(uuid, text, extensions.vector, integer, integer) from public, anon, authenticated;
revoke all on function public.qnotes_read_queue(text, integer, integer) from public, anon, authenticated;
revoke all on function public.qnotes_delete_queue_message(text, bigint) from public, anon, authenticated;
revoke all on function public.qnotes_archive_queue_message(text, bigint) from public, anon, authenticated;
grant execute on function public.qnotes_keyword_search(uuid, text, integer) to service_role;
grant execute on function public.qnotes_semantic_search(uuid, extensions.vector, integer) to service_role;
grant execute on function public.qnotes_hybrid_search(uuid, text, extensions.vector, integer, integer) to service_role;
grant execute on function public.qnotes_read_queue(text, integer, integer) to service_role;
grant execute on function public.qnotes_delete_queue_message(text, bigint) to service_role;
grant execute on function public.qnotes_archive_queue_message(text, bigint) to service_role;

select cron.schedule(
  'qnotes-process-embeddings', '* * * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_project_url') || '/functions/v1/embedding-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-qnotes-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_internal_worker_secret')),
    body := '{}'::jsonb
  );$$
);

select cron.schedule(
  'qnotes-process-attachments', '* * * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_project_url') || '/functions/v1/attachment-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-qnotes-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'qnotes_internal_worker_secret')),
    body := '{}'::jsonb
  );$$
);
