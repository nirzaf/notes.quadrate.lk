create extension if not exists pg_trgm with schema extensions;

alter table notesdb.search_documents
  drop constraint if exists search_documents_source_type_check;
alter table notesdb.search_documents
  add constraint search_documents_source_type_check
  check (source_type in ('note_metadata', 'note_chunk', 'copy_block', 'code_block', 'attachment_chunk'));

alter table notesdb.search_documents
  add column if not exists embedding_model_version text;

update notesdb.search_documents
set embedding_model_version = 'v1'
where embedding_status = 'ready'
  and embedding_model = 'gte-small'
  and embedding_model_version is null;

create index if not exists search_documents_owner_type_position_key
  on notesdb.search_documents (owner_id, source_type, note_id, position, id);
create index if not exists search_documents_embedding_ready_model_key
  on notesdb.search_documents (embedding_model, embedding_model_version, owner_id, note_id)
  where embedding_status = 'ready' and embedding is not null;

create or replace function public.qnotes_search_snippet(p_content text, p_query text)
returns text
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  source_text text := coalesce(p_content, '');
  normalized_query text := regexp_replace(lower(btrim(coalesce(p_query, ''))), '\s+', ' ', 'g');
  match_start integer;
  window_start integer;
  headline text;
begin
  if source_text = '' then return ''; end if;

  if normalized_query <> '' then
    match_start := strpos(lower(source_text), normalized_query);
    if match_start > 0 then
      window_start := greatest(1, match_start - 120);
      return substring(source_text from window_start for 280);
    end if;

    begin
      headline := ts_headline(
        'simple',
        source_text,
        websearch_to_tsquery('simple', p_query),
        'MaxFragments=2,MinWords=8,MaxWords=40,FragmentDelimiter= … '
      );
      if headline <> '' then return left(headline, 280); end if;
    exception when others then
      null;
    end;
  end if;

  return left(source_text, 280);
end;
$$;

create or replace function public.qnotes_sync_note_metadata(p_note_id uuid, p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  note_row notesdb.notes%rowtype;
  notebook_name text;
  metadata_content text;
  metadata_hash text;
  existing notesdb.search_documents%rowtype;
  found_document boolean;
  should_enqueue boolean;
  document_id uuid;
begin
  select * into note_row
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id;

  if not found then return; end if;

  select nb.name into notebook_name
  from notesdb.notebooks nb
  where nb.id = note_row.notebook_id and nb.owner_id = p_owner_id;

  metadata_content := format(
    E'Title: %s\nSlug: %s\nTags: %s\nNotebook: %s',
    note_row.title,
    note_row.slug,
    coalesce(array_to_string(note_row.tags, ', '), ''),
    coalesce(notebook_name, '')
  );
  metadata_hash := encode(digest(metadata_content, 'sha256'), 'hex');

  existing := null;
  select * into existing
  from notesdb.search_documents d
  where d.note_id = p_note_id
    and d.source_type = 'note_metadata'
    and d.source_key = 'metadata'
  for update;
  found_document := found;
  should_enqueue := not found_document
    or existing.content_hash is distinct from metadata_hash
    or existing.embedding_status = 'failed';

  insert into notesdb.search_documents (
    owner_id, note_id, source_type, source_id, source_key, source_title,
    heading_path, content, content_hash, position, embedding_status
  ) values (
    p_owner_id, p_note_id, 'note_metadata', null, 'metadata', note_row.title,
    null, metadata_content, metadata_hash, 0, 'pending'
  )
  on conflict (note_id, source_type, source_key) do update set
    owner_id = excluded.owner_id,
    source_title = excluded.source_title,
    content = excluded.content,
    content_hash = excluded.content_hash,
    position = excluded.position,
    embedding = case
      when notesdb.search_documents.content_hash = excluded.content_hash
        and notesdb.search_documents.embedding_status = 'ready'
      then notesdb.search_documents.embedding
      else null
    end,
    embedding_status = case
      when notesdb.search_documents.content_hash = excluded.content_hash
        and notesdb.search_documents.embedding_status = 'ready'
      then 'ready'
      else 'pending'
    end,
    embedding_error = case
      when notesdb.search_documents.content_hash = excluded.content_hash
        and notesdb.search_documents.embedding_status = 'ready'
      then notesdb.search_documents.embedding_error
      else null
    end,
    embedding_model = case
      when notesdb.search_documents.content_hash = excluded.content_hash
        and notesdb.search_documents.embedding_status = 'ready'
      then notesdb.search_documents.embedding_model
      else null
    end,
    embedding_model_version = case
      when notesdb.search_documents.content_hash = excluded.content_hash
        and notesdb.search_documents.embedding_status = 'ready'
      then notesdb.search_documents.embedding_model_version
      else null
    end
  returning id into document_id;

  if should_enqueue then
    perform public.qnotes_enqueue_embedding(document_id, p_owner_id, metadata_hash);
  end if;
end;
$$;

create or replace function public.qnotes_sync_note_content(
  p_note_id uuid,
  p_owner_id uuid,
  p_blocks jsonb,
  p_documents jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item jsonb;
  existing notesdb.search_documents%rowtype;
  found_document boolean;
  should_enqueue boolean;
  document_id uuid;
  source_type_value text;
  source_key_value text;
  source_title text;
  heading_path text;
  content text;
  content_hash text;
  position_value integer;
begin
  p_blocks := coalesce(p_blocks, '[]'::jsonb);
  p_documents := coalesce(p_documents, '[]'::jsonb);

  delete from notesdb.note_blocks b
  where b.note_id = p_note_id
    and not exists (
      select 1 from jsonb_array_elements(p_blocks) x
      where x->>'blockKey' = b.block_key
    );

  for item in select value from jsonb_array_elements(p_blocks)
  loop
    insert into notesdb.note_blocks (
      owner_id, note_id, block_key, block_type, title, language, content,
      position, copyable, content_hash
    ) values (
      p_owner_id,
      p_note_id,
      item->>'blockKey',
      item->>'blockType',
      item->>'title',
      item->>'language',
      item->>'content',
      (item->>'position')::integer,
      coalesce((item->>'copyable')::boolean, true),
      item->>'contentHash'
    )
    on conflict (note_id, block_key) do update set
      owner_id = excluded.owner_id,
      block_type = excluded.block_type,
      title = excluded.title,
      language = excluded.language,
      content = excluded.content,
      position = excluded.position,
      copyable = excluded.copyable,
      content_hash = excluded.content_hash;
  end loop;

  delete from notesdb.search_documents d
  where d.note_id = p_note_id
    and d.source_type <> 'note_metadata'
    and not exists (
      select 1 from jsonb_array_elements(p_documents) x
      where x->>'sourceType' = d.source_type and x->>'sourceKey' = d.source_key
    );

  for item in select value from jsonb_array_elements(p_documents)
  loop
    source_type_value := item->>'sourceType';
    source_key_value := item->>'sourceKey';
    source_title := coalesce(item->>'sourceTitle', '');
    heading_path := item->>'headingPath';
    content := coalesce(item->>'content', '');
    content_hash := item->>'contentHash';
    position_value := (item->>'position')::integer;
    existing := null;
    select * into existing
    from notesdb.search_documents d
    where d.note_id = p_note_id
      and d.source_type = source_type_value
      and d.source_key = source_key_value
    for update;
    found_document := found;
    should_enqueue := not found_document
      or existing.content_hash is distinct from content_hash
      or existing.embedding_status = 'failed';

    insert into notesdb.search_documents (
      owner_id, note_id, source_type, source_id, source_key, source_title,
      heading_path, content, content_hash, position, embedding_status
    ) values (
      p_owner_id,
      p_note_id,
      source_type_value,
      nullif(item->>'sourceId', '')::uuid,
      source_key_value,
      source_title,
      heading_path,
      content,
      content_hash,
      position_value,
      'pending'
    )
    on conflict (note_id, source_type, source_key) do update set
      owner_id = excluded.owner_id,
      source_id = excluded.source_id,
      source_title = excluded.source_title,
      heading_path = excluded.heading_path,
      content = excluded.content,
      content_hash = excluded.content_hash,
      position = excluded.position,
      embedding = case
        when notesdb.search_documents.content_hash = excluded.content_hash
          and notesdb.search_documents.embedding_status = 'ready'
        then notesdb.search_documents.embedding
        else null
      end,
      embedding_status = case
        when notesdb.search_documents.content_hash = excluded.content_hash
          and notesdb.search_documents.embedding_status = 'ready'
        then 'ready'
        else 'pending'
      end,
      embedding_error = case
        when notesdb.search_documents.content_hash = excluded.content_hash
          and notesdb.search_documents.embedding_status = 'ready'
        then notesdb.search_documents.embedding_error
        else null
      end,
      embedding_model = case
        when notesdb.search_documents.content_hash = excluded.content_hash
          and notesdb.search_documents.embedding_status = 'ready'
        then notesdb.search_documents.embedding_model
        else null
      end,
      embedding_model_version = case
        when notesdb.search_documents.content_hash = excluded.content_hash
          and notesdb.search_documents.embedding_status = 'ready'
        then notesdb.search_documents.embedding_model_version
        else null
      end
    returning id into document_id;

    if should_enqueue then
      perform public.qnotes_enqueue_embedding(document_id, p_owner_id, content_hash);
    end if;
  end loop;

  perform public.qnotes_sync_note_metadata(p_note_id, p_owner_id);
end;
$$;

create or replace function public.qnotes_sync_note_metadata_on_move()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.qnotes_sync_note_metadata(new.id, new.owner_id);
  return new;
end;
$$;

drop trigger if exists notes_sync_metadata_on_notebook_change on notesdb.notes;
create trigger notes_sync_metadata_on_notebook_change
after update of notebook_id on notesdb.notes
for each row execute function public.qnotes_sync_note_metadata_on_move();

do $$
declare
  note_record record;
begin
  for note_record in select id, owner_id from notesdb.notes loop
    perform public.qnotes_sync_note_metadata(note_record.id, note_record.owner_id);
  end loop;
end;
$$;

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
      lower(btrim(coalesce(p_query, ''))) as normalized_query,
      websearch_to_tsquery('simple', coalesce(p_query, '')) as ts_query,
      greatest(1, least(coalesce(p_limit, 20), 50)) as result_limit
  ),
  base as (
    select
      d.id,
      d.note_id,
      n.slug as note_slug,
      n.title as note_title,
      d.source_type,
      coalesce(b.id, d.source_id) as source_id,
      d.source_key,
      d.source_title,
      d.heading_path,
      d.content,
      d.search_vector,
      b.block_key,
      b.language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as attachment_id,
      case d.source_type
        when 'code_block' then 0
        when 'copy_block' then 1
        when 'note_metadata' then 2
        when 'note_chunk' then 3
        else 4
      end as source_priority
    from notesdb.search_documents d
    join notesdb.notes n
      on n.id = d.note_id
      and n.owner_id = p_owner_id
      and n.deleted_at is null
    left join notesdb.note_blocks b
      on b.note_id = d.note_id
      and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block')
      and b.block_key = d.source_key
    where d.owner_id = p_owner_id
  ),
  exact_candidates as (
    select b.id,
      row_number() over (order by b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where (b.source_type = 'note_metadata' and lower(b.note_slug) = p.normalized_query)
       or lower(b.source_key) = p.normalized_query
       or lower(coalesce(b.block_key, '')) = p.normalized_query
  ),
  title_candidates as (
    select b.id,
      row_number() over (order by b.source_priority, b.id)::integer as channel_rank
    from base b cross join params p
    where (b.source_type = 'note_metadata' and lower(b.note_title) = p.normalized_query)
       or (b.source_type in ('copy_block', 'code_block', 'attachment_chunk')
         and lower(b.source_title) = p.normalized_query)
  ),
  fts_candidates as (
    select b.id,
      row_number() over (
        order by ts_rank_cd(b.search_vector, p.ts_query) desc, b.source_priority, b.id
      )::integer as channel_rank
    from base b cross join params p
    where b.search_vector @@ p.ts_query
  ),
  trigram_candidates as (
    select b.id,
      row_number() over (
        order by greatest(
          similarity(lower(b.source_title), p.normalized_query),
          similarity(lower(b.source_key), p.normalized_query),
          similarity(lower(b.content), p.normalized_query)
        ) desc, b.source_priority, b.id
      )::integer as channel_rank
    from base b cross join params p
    where lower(b.source_title) % p.normalized_query
       or lower(b.source_key) % p.normalized_query
       or lower(b.content) % p.normalized_query
       or position(p.normalized_query in lower(b.content)) > 0
  ),
  keyword_scores as (
    select id,
      sum(weight / (60.0 + channel_rank))::double precision as score
    from (
      select id, channel_rank, 2.0::double precision as weight from exact_candidates
      union all
      select id, channel_rank, 1.5::double precision from title_candidates
      union all
      select id, channel_rank, 1.2::double precision from fts_candidates
      union all
      select id, channel_rank, 0.8::double precision from trigram_candidates
    ) channels
    group by id
  ),
  ranked as (
    select
      b.*,
      k.score,
      row_number() over (order by k.score desc, b.source_priority, b.id)::integer as keyword_rank
    from keyword_scores k
    join base b on b.id = k.id
  ),
  per_note as (
    select ranked.*,
      row_number() over (
        partition by note_id
        order by score desc, source_priority, id
      )::integer as note_rank
    from ranked
  )
  select
    id,
    note_id,
    note_slug,
    note_title,
    source_type,
    source_id,
    source_key,
    source_title,
    heading_path,
    public.qnotes_search_snippet(content, p_query),
    score,
    keyword_rank,
    null::integer,
    block_key,
    language,
    attachment_id
  from per_note
  where note_rank <= 2
  order by score desc, source_priority, id
  limit (select result_limit from params);
$$;

drop function if exists public.qnotes_semantic_search(uuid, extensions.vector, integer);

create or replace function public.qnotes_semantic_search(p_owner_id uuid, p_query text, p_embedding extensions.vector(384), p_limit integer)
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
    select greatest(1, least(coalesce(p_limit, 20), 50)) as result_limit
  ),
  semantic_candidates as materialized (
    select
      d.id,
      d.embedding <#> p_embedding as distance
    from notesdb.search_documents d
    join notesdb.notes n
      on n.id = d.note_id
      and n.owner_id = p_owner_id
      and n.deleted_at is null
    where d.owner_id = p_owner_id
      and d.embedding_status = 'ready'
      and d.embedding is not null
      and d.embedding_model = 'gte-small'
      and d.embedding_model_version = 'v1'
    order by d.embedding <#> p_embedding
    limit greatest(50, least(coalesce(p_limit, 20) * 5, 250))
  ),
  ranked as (
    select
      d.id,
      d.note_id,
      n.slug as note_slug,
      n.title as note_title,
      d.source_type,
      coalesce(b.id, d.source_id) as source_id,
      d.source_key,
      d.source_title,
      d.heading_path,
      d.content,
      -sc.distance as score,
      row_number() over (order by sc.distance, d.id)::integer as semantic_rank,
      b.block_key,
      b.language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as attachment_id,
      case d.source_type
        when 'code_block' then 0
        when 'copy_block' then 1
        when 'note_metadata' then 2
        when 'note_chunk' then 3
        else 4
      end as source_priority
    from semantic_candidates sc
    join notesdb.search_documents d on d.id = sc.id
    join notesdb.notes n
      on n.id = d.note_id
      and n.owner_id = p_owner_id
      and n.deleted_at is null
    left join notesdb.note_blocks b
      on b.note_id = d.note_id
      and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block')
      and b.block_key = d.source_key
  ),
  per_note as (
    select ranked.*,
      row_number() over (
        partition by note_id
        order by score desc, source_priority, id
      )::integer as note_rank
    from ranked
  )
  select
    id,
    note_id,
    note_slug,
    note_title,
    source_type,
    source_id,
    source_key,
    source_title,
    heading_path,
    public.qnotes_search_snippet(content, p_query),
    score,
    null::integer,
    semantic_rank,
    block_key,
    language,
    attachment_id
  from per_note
  where note_rank <= 2
  order by score desc, source_priority, id
  limit (select result_limit from params);
$$;

create or replace function public.qnotes_hybrid_search(
  p_owner_id uuid,
  p_query text,
  p_embedding extensions.vector(384),
  p_limit integer,
  p_rrf_k integer default 60
)
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
      greatest(1, least(coalesce(p_limit, 20), 50)) as result_limit,
      greatest(1, coalesce(p_rrf_k, 60))::double precision as rrf_k
  ),
  keyword as (
    select k.*
    from public.qnotes_keyword_search(p_owner_id, p_query, 50) k
  ),
  semantic as (
    select s.*
    from public.qnotes_semantic_search(p_owner_id, p_query, p_embedding, 50) s
  ),
  combined as (
    select
      coalesce(k.id, s.id) as result_id,
      coalesce(k.note_id, s.note_id) as result_note_id,
      coalesce(k.note_slug, s.note_slug) as result_note_slug,
      coalesce(k.note_title, s.note_title) as result_note_title,
      coalesce(k.source_type, s.source_type) as result_source_type,
      coalesce(k.source_id, s.source_id) as result_source_id,
      coalesce(k.source_key, s.source_key) as result_source_key,
      coalesce(k.source_title, s.source_title) as result_source_title,
      coalesce(k.heading_path, s.heading_path) as result_heading_path,
      coalesce(k.snippet, s.snippet) as result_snippet,
      (
        coalesce(k.score, 0)
        + coalesce(1.0 / (p.rrf_k + s.semantic_rank), 0)
      )::double precision as result_score,
      k.keyword_rank as result_keyword_rank,
      s.semantic_rank as result_semantic_rank,
      coalesce(k.block_key, s.block_key) as result_block_key,
      coalesce(k.language, s.language) as result_language,
      coalesce(k.attachment_id, s.attachment_id) as result_attachment_id,
      case coalesce(k.source_type, s.source_type)
        when 'code_block' then 0
        when 'copy_block' then 1
        when 'note_metadata' then 2
        when 'note_chunk' then 3
        else 4
      end as source_priority
    from keyword k
    full join semantic s on s.id = k.id
    cross join params p
  ),
  per_note as (
    select combined.*,
      row_number() over (
        partition by result_note_id
        order by result_score desc, source_priority, result_id
      )::integer as note_rank
    from combined
  )
  select
    result_id,
    result_note_id,
    result_note_slug,
    result_note_title,
    result_source_type,
    result_source_id,
    result_source_key,
    result_source_title,
    result_heading_path,
    result_snippet,
    result_score,
    result_keyword_rank,
    result_semantic_rank,
    result_block_key,
    result_language,
    result_attachment_id
  from per_note
  where note_rank <= 2
  order by result_score desc, source_priority, result_id
  limit (select result_limit from params);
$$;

revoke all on function public.qnotes_keyword_search(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.qnotes_keyword_search(uuid, text, integer) to service_role;
revoke all on function public.qnotes_semantic_search(uuid, text, extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.qnotes_semantic_search(uuid, text, extensions.vector, integer) to service_role;
revoke all on function public.qnotes_hybrid_search(uuid, text, extensions.vector, integer, integer) from public, anon, authenticated;
grant execute on function public.qnotes_hybrid_search(uuid, text, extensions.vector, integer, integer) to service_role;
revoke all on function public.qnotes_search_snippet(text, text) from public, anon, authenticated;
revoke all on function public.qnotes_sync_note_metadata(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_sync_note_metadata_on_move() from public, anon, authenticated;
grant execute on function public.qnotes_search_snippet(text, text) to service_role;
grant execute on function public.qnotes_sync_note_metadata(uuid, uuid) to service_role;
grant execute on function public.qnotes_sync_note_metadata_on_move() to service_role;
