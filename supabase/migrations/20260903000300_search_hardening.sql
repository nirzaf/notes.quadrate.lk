-- Search hardening is intentionally additive. Existing vectors are re-queued
-- when their exact embedding input or model version is not known.
alter table notesdb.notes add column if not exists dedupe_key text;
alter table notesdb.search_documents add column if not exists embedding_input_hash text;
alter table notesdb.search_documents add column if not exists embedding_queued_at timestamptz;
alter table notesdb.search_documents add column if not exists page_number integer;

create unique index if not exists notes_owner_dedupe_key_idx
  on notesdb.notes (owner_id, dedupe_key)
  where dedupe_key is not null and deleted_at is null;
create index if not exists search_documents_owner_queue_age_idx
  on notesdb.search_documents (owner_id, embedding_status, embedding_queued_at)
  where embedding_status in ('pending', 'failed');

create or replace function public.qnotes_embedding_input(
  p_source_title text,
  p_heading_path text,
  p_content text
) returns text
language sql
immutable
set search_path = public, extensions
as $$
  select concat_ws(E'\n\n',
    nullif(btrim(coalesce(p_source_title, '')), ''),
    nullif(btrim(coalesce(p_heading_path, '')), ''),
    nullif(btrim(coalesce(p_content, '')), '')
  );
$$;

create or replace function public.qnotes_embedding_input_hash(
  p_source_title text,
  p_heading_path text,
  p_content text
) returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(digest(public.qnotes_embedding_input(p_source_title, p_heading_path, p_content), 'sha256'), 'hex');
$$;

create or replace function public.qnotes_enqueue_embedding(
  p_document_id uuid,
  p_owner_id uuid,
  p_hash text,
  p_input_hash text,
  p_model_version text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update notesdb.search_documents
  set embedding_queued_at = timezone('utc', now())
  where id = p_document_id
    and owner_id = p_owner_id
    and content_hash = p_hash
    and embedding_input_hash = p_input_hash;
  perform pgmq.send('note-embeddings', jsonb_build_object(
    'searchDocumentId', p_document_id,
    'ownerId', p_owner_id,
    'contentHash', p_hash,
    'embeddingInputHash', p_input_hash,
    'embeddingModelVersion', p_model_version
  ));
end;
$$;

create or replace function public.qnotes_enqueue_embedding(
  p_document_id uuid,
  p_owner_id uuid,
  p_hash text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  input_hash text;
begin
  select d.embedding_input_hash
  into input_hash
  from notesdb.search_documents d
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.content_hash = p_hash;
  if input_hash is null then return; end if;
  perform public.qnotes_enqueue_embedding(p_document_id, p_owner_id, p_hash, input_hash, 'v2');
end;
$$;

create or replace function public.qnotes_prepare_search_document()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  expected_input_hash text;
  page_match text[];
  input_changed boolean := false;
begin
  expected_input_hash := public.qnotes_embedding_input_hash(new.source_title, new.heading_path, new.content);
  new.embedding_input_hash := expected_input_hash;

  if tg_op = 'UPDATE' then
    input_changed := old.embedding_input_hash is distinct from expected_input_hash;
  end if;

  if new.source_type = 'attachment_chunk' and new.page_number is null then
    page_match := regexp_match(new.source_key, ':page:([0-9]+):');
    if page_match is not null then new.page_number := page_match[1]::integer; end if;
  end if;

  if new.embedding_status = 'pending' then
    new.embedding_model := 'gte-small';
    new.embedding_model_version := 'v2';
    new.embedding_queued_at := coalesce(new.embedding_queued_at, timezone('utc', now()));
  elsif new.embedding_status = 'ready' then
    if new.embedding is null
      or new.embedding_model is distinct from 'gte-small'
      or new.embedding_model_version is distinct from 'v2'
      or input_changed
    then
      new.embedding := null;
      new.embedding_status := 'pending';
      new.embedding_model := 'gte-small';
      new.embedding_model_version := 'v2';
      new.embedding_error := null;
      new.embedding_queued_at := timezone('utc', now());
      -- The existing sync functions already enqueue content changes. This
      -- branch covers title/heading-only changes whose content hash is stable.
      if tg_op = 'UPDATE' then
        if old.embedding_status = 'ready' and old.content_hash is not distinct from new.content_hash then
          perform pgmq.send('note-embeddings', jsonb_build_object(
            'searchDocumentId', new.id,
            'ownerId', new.owner_id,
            'contentHash', new.content_hash,
            'embeddingInputHash', expected_input_hash,
            'embeddingModelVersion', 'v2'
          ));
        end if;
      end if;
    else
      new.embedding_queued_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists search_documents_prepare_embedding on notesdb.search_documents;
create trigger search_documents_prepare_embedding
before insert or update on notesdb.search_documents
for each row execute function public.qnotes_prepare_search_document();

-- Never claim a historical vector matches the current input contract. Keep
-- valid v2 vectors, and enqueue every other document for regeneration.
update notesdb.search_documents d
set embedding = case
      when d.embedding_status = 'ready'
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      then d.embedding
      else null
    end,
    embedding_status = case
      when d.embedding_status = 'ready'
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      then 'ready'
      else 'pending'
    end,
    embedding_model = 'gte-small',
    embedding_model_version = 'v2',
    embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content),
    embedding_error = case
      when d.embedding_status = 'ready'
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      then d.embedding_error
      else null
    end,
    embedding_queued_at = case
      when d.embedding_status = 'ready'
       and d.embedding_model = 'gte-small'
       and d.embedding_model_version = 'v2'
       and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      then null
      else timezone('utc', now())
    end;

do $$
declare
  document_record record;
begin
  for document_record in
    select id, owner_id, content_hash, embedding_input_hash
    from notesdb.search_documents
    where embedding_status = 'pending'
  loop
    perform public.qnotes_enqueue_embedding(
      document_record.id,
      document_record.owner_id,
      document_record.content_hash,
      document_record.embedding_input_hash,
      'v2'
    );
  end loop;
end;
$$;

create or replace function public.qnotes_note_json(p_note notesdb.notes)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_note.id,
    'slug', p_note.slug,
    'title', p_note.title,
    'contentMarkdown', p_note.content_markdown,
    'contentPlain', p_note.content_plain,
    'tags', p_note.tags,
    'notebookId', p_note.notebook_id,
    'version', p_note.version,
    'createdAt', p_note.created_at,
    'updatedAt', p_note.updated_at,
    'deletedAt', p_note.deleted_at
  );
$$;

create or replace function public.qnotes_create_note(
  p_owner_id uuid,
  p_note_id uuid,
  p_slug text,
  p_title text,
  p_content_markdown text,
  p_content_plain text,
  p_tags text[],
  p_device_id uuid,
  p_mutation_id uuid,
  p_request_hash text,
  p_blocks jsonb,
  p_documents jsonb,
  p_notebook_id uuid,
  p_dedupe_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored notesdb.note_mutations%rowtype;
  note_row notesdb.notes%rowtype;
  response jsonb;
begin
  select * into stored
  from notesdb.note_mutations
  where owner_id = p_owner_id and mutation_id = p_mutation_id
  for update;
  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;

  if p_dedupe_key is not null then
    select * into note_row
    from notesdb.notes
    where owner_id = p_owner_id and dedupe_key = p_dedupe_key and deleted_at is null
    for update;
    if found then
      return jsonb_build_object('status', 'dedupe_existing', 'note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(note_row.id));
    end if;
  end if;
  if p_notebook_id is not null and not exists (
    select 1 from notesdb.notebooks where id = p_notebook_id and owner_id = p_owner_id
  ) then
    return jsonb_build_object('status', 'notebook_not_found');
  end if;
  if exists (select 1 from notesdb.notes where owner_id = p_owner_id and deleted_at is null and lower(slug) = lower(p_slug)) then
    return jsonb_build_object('status', 'slug_conflict');
  end if;
  insert into notesdb.notes (
    id, owner_id, slug, title, content_markdown, content_plain, tags,
    notebook_id, dedupe_key, version, last_mutation_id, updated_by_device_id
  ) values (
    p_note_id, p_owner_id, p_slug, p_title, p_content_markdown, p_content_plain,
    coalesce(p_tags, '{}'), p_notebook_id, p_dedupe_key, 1, p_mutation_id, p_device_id
  ) returning * into note_row;
  perform public.qnotes_sync_note_content(p_note_id, p_owner_id, p_blocks, p_documents);
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into notesdb.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'created', p_request_hash, p_note_id, 1, response);
  return jsonb_build_object('status', 'ok') || response;
exception when unique_violation then
  if p_dedupe_key is not null and exists (
    select 1 from notesdb.notes where owner_id = p_owner_id and dedupe_key = p_dedupe_key and deleted_at is null
  ) then
    select * into note_row from notesdb.notes where owner_id = p_owner_id and dedupe_key = p_dedupe_key and deleted_at is null;
    return jsonb_build_object('status', 'dedupe_existing', 'note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(note_row.id));
  end if;
  if exists (select 1 from notesdb.notes where owner_id = p_owner_id and deleted_at is null and lower(slug) = lower(p_slug)) then
    return jsonb_build_object('status', 'slug_conflict');
  end if;
  raise;
end;
$$;

create or replace function public.qnotes_create_note(
  p_owner_id uuid,
  p_note_id uuid,
  p_slug text,
  p_title text,
  p_content_markdown text,
  p_content_plain text,
  p_tags text[],
  p_device_id uuid,
  p_mutation_id uuid,
  p_request_hash text,
  p_blocks jsonb,
  p_documents jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return public.qnotes_create_note(
    p_owner_id, p_note_id, p_slug, p_title, p_content_markdown, p_content_plain,
    p_tags, p_device_id, p_mutation_id, p_request_hash, p_blocks, p_documents, null, null
  );
end;
$$;

-- Preserve tags for callers that intentionally omit the optional field.
create or replace function public.qnotes_update_note(
  p_owner_id uuid,
  p_note_id uuid,
  p_slug text,
  p_title text,
  p_content_markdown text,
  p_content_plain text,
  p_tags text[],
  p_expected_version bigint,
  p_device_id uuid,
  p_mutation_id uuid,
  p_request_hash text,
  p_blocks jsonb,
  p_documents jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored notesdb.note_mutations%rowtype;
  note_row notesdb.notes%rowtype;
  response jsonb;
begin
  select * into stored
  from notesdb.note_mutations
  where owner_id = p_owner_id and mutation_id = p_mutation_id
  for update;
  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  select * into note_row
  from notesdb.notes
  where id = p_note_id and owner_id = p_owner_id
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if note_row.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version, 'currentNote', public.qnotes_note_json(note_row));
  end if;
  if exists (
    select 1 from notesdb.notes
    where owner_id = p_owner_id and id <> p_note_id and deleted_at is null and lower(slug) = lower(p_slug)
  ) then
    return jsonb_build_object('status', 'slug_conflict');
  end if;
  update notesdb.notes
  set slug = p_slug,
      title = p_title,
      content_markdown = p_content_markdown,
      content_plain = p_content_plain,
      tags = coalesce(p_tags, note_row.tags),
      version = version + 1,
      last_mutation_id = p_mutation_id,
      updated_by_device_id = p_device_id,
      updated_at = timezone('utc', now())
  where id = p_note_id and owner_id = p_owner_id and version = p_expected_version
  returning * into note_row;
  perform public.qnotes_sync_note_content(p_note_id, p_owner_id, p_blocks, p_documents);
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into notesdb.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'updated', p_request_hash, p_note_id, note_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_search_freshness(p_owner_id uuid)
returns table (pending_documents integer, failed_documents integer, oldest_queued_at timestamptz)
language sql
security definer
set search_path = public, extensions
as $$
  select
    count(*) filter (where embedding_status = 'pending')::integer,
    count(*) filter (where embedding_status = 'failed')::integer,
    min(embedding_queued_at) filter (where embedding_status = 'pending')
  from notesdb.search_documents
  where owner_id = p_owner_id;
$$;

-- Filtered keyword retrieval. Filtering is part of the ranked relation, before
-- score ordering, per-note caps, and pagination.
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
      websearch_to_tsquery('simple', coalesce(p_query, '')) as ts_query,
      greatest(1, least(coalesce(p_limit, 21), 51)) as result_limit,
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
  base as (
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
       or lower(b.content) % p.normalized_query or position(p.normalized_query in lower(b.content)) > 0
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

create or replace function public.qnotes_semantic_search(
  p_owner_id uuid,
  p_query text,
  p_embedding extensions.vector(384),
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
    select greatest(1, least(coalesce(p_limit, 21), 51)) as result_limit,
      greatest(0, coalesce(p_offset, 0)) as result_offset,
      greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit,
      greatest(50, least((greatest(0, coalesce(p_offset, 0)) + greatest(1, least(coalesce(p_limit, 21), 51))) * 5, 1000)) as candidate_limit
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
  semantic_candidates as materialized (
    select d.id, d.embedding <#> p_embedding as distance
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
    cross join filter_values f
    where d.owner_id = p_owner_id and d.embedding_status = 'ready' and d.embedding is not null
      and d.embedding_model = 'gte-small' and d.embedding_model_version = 'v2'
      and d.embedding_input_hash = public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      and (cardinality(f.notebook_ids) = 0 or n.notebook_id = any(f.notebook_ids))
      and (cardinality(f.tags) = 0 or n.tags @> f.tags)
      and (cardinality(f.source_types) = 0 or d.source_type = any(f.source_types))
      and (cardinality(f.languages) = 0 or lower(coalesce(b.language, '')) = any(f.languages))
      and (f.updated_after is null or n.updated_at > f.updated_after)
      and (not f.unfiled or n.notebook_id is null)
    order by d.embedding <#> p_embedding
    limit (select candidate_limit from params)
  ),
  ranked as (
    select d.id, d.note_id, n.slug as note_slug, n.title as note_title, d.source_type,
      coalesce(b.id, d.source_id) as source_id, d.source_key, d.source_title, d.heading_path,
      d.content, -sc.distance as score, row_number() over (order by sc.distance, d.id)::integer as semantic_rank,
      b.block_key, b.language,
      case when d.source_type = 'attachment_chunk' then d.source_id else null end as attachment_id,
      case d.source_type when 'code_block' then 0 when 'copy_block' then 1 when 'note_metadata' then 2 when 'note_chunk' then 3 else 4 end as source_priority
    from semantic_candidates sc
    join notesdb.search_documents d on d.id = sc.id
    join notesdb.notes n on n.id = d.note_id and n.owner_id = p_owner_id and n.deleted_at is null
    left join notesdb.note_blocks b on b.note_id = d.note_id and b.owner_id = p_owner_id
      and d.source_type in ('copy_block', 'code_block') and b.block_key = d.source_key
  ),
  per_note as (
    select ranked.*, row_number() over (partition by note_id order by score desc, source_priority, id)::integer as note_rank
    from ranked
  )
  select id, note_id, note_slug, note_title, source_type, source_id, source_key,
    source_title, heading_path, public.qnotes_search_snippet(content, p_query),
    score, null::integer, semantic_rank, block_key, language, attachment_id
  from per_note cross join params p
  where note_rank <= p.note_limit
  order by score desc, source_priority, id
  limit (select result_limit from params) offset (select result_offset from params);
$$;

create or replace function public.qnotes_hybrid_search(
  p_owner_id uuid,
  p_query text,
  p_embedding extensions.vector(384),
  p_limit integer,
  p_rrf_k integer,
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
    select greatest(1, least(coalesce(p_limit, 21), 51)) as result_limit,
      greatest(0, coalesce(p_offset, 0)) as result_offset,
      greatest(1, least(coalesce(p_max_per_note, 2), 10)) as note_limit,
      greatest(50, least(greatest(0, coalesce(p_offset, 0)) + greatest(1, least(coalesce(p_limit, 21), 51)), 500)) as candidate_limit,
      greatest(1, coalesce(p_rrf_k, 60))::double precision as rrf_k
  ),
  keyword as (
    select k.* from public.qnotes_keyword_search(p_owner_id, p_query, (select candidate_limit from params), p_filters, 0, (select note_limit from params)) k
  ),
  semantic as (
    select s.* from public.qnotes_semantic_search(p_owner_id, p_query, p_embedding, (select candidate_limit from params), p_filters, 0, (select note_limit from params)) s
  ),
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
      (coalesce(k.score, 0) + coalesce(1.0 / (p.rrf_k + s.semantic_rank), 0))::double precision as result_score,
      k.keyword_rank as result_keyword_rank, s.semantic_rank as result_semantic_rank,
      coalesce(k.block_key, s.block_key) as result_block_key,
      coalesce(k.language, s.language) as result_language,
      coalesce(k.attachment_id, s.attachment_id) as result_attachment_id,
      case coalesce(k.source_type, s.source_type) when 'code_block' then 0 when 'copy_block' then 1 when 'note_metadata' then 2 when 'note_chunk' then 3 else 4 end as source_priority
    from keyword k full join semantic s on s.id = k.id cross join params p
  ),
  per_note as (
    select combined.*, row_number() over (partition by result_note_id order by result_score desc, source_priority, result_id)::integer as note_rank
    from combined
  )
  select result_id, result_note_id, result_note_slug, result_note_title,
    result_source_type, result_source_id, result_source_key, result_source_title,
    result_heading_path, result_snippet, result_score, result_keyword_rank,
    result_semantic_rank, result_block_key, result_language, result_attachment_id
  from per_note cross join params p
  where note_rank <= p.note_limit
  order by result_score desc, source_priority, result_id
  limit (select result_limit from params) offset (select result_offset from params);
$$;

revoke all on function public.qnotes_enqueue_embedding(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.qnotes_enqueue_embedding(uuid, uuid, text, text, text) to service_role;
revoke all on function public.qnotes_enqueue_embedding(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qnotes_enqueue_embedding(uuid, uuid, text) to service_role;
revoke all on function public.qnotes_search_freshness(uuid) from public, anon, authenticated;
grant execute on function public.qnotes_search_freshness(uuid) to service_role;
revoke all on function public.qnotes_prepare_search_document() from public, anon, authenticated;
grant execute on function public.qnotes_prepare_search_document() to service_role;
revoke all on function public.qnotes_create_note(uuid, uuid, text, text, text, text, text[], uuid, uuid, text, jsonb, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.qnotes_create_note(uuid, uuid, text, text, text, text, text[], uuid, uuid, text, jsonb, jsonb, uuid, text) to service_role;
revoke all on function public.qnotes_keyword_search(uuid, text, integer, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.qnotes_keyword_search(uuid, text, integer, jsonb, integer, integer) to service_role;
revoke all on function public.qnotes_semantic_search(uuid, text, extensions.vector, integer, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.qnotes_semantic_search(uuid, text, extensions.vector, integer, jsonb, integer, integer) to service_role;
revoke all on function public.qnotes_hybrid_search(uuid, text, extensions.vector, integer, integer, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.qnotes_hybrid_search(uuid, text, extensions.vector, integer, integer, jsonb, integer, integer) to service_role;
