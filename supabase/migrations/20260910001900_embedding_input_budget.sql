-- US-25: keep embedding inputs inside the verified provider boundary while
-- retaining the full source in note_blocks for exact block retrieval.

alter table notesdb.search_documents add column if not exists block_key text;
create index if not exists search_documents_owner_note_block_key
  on notesdb.search_documents (owner_id, note_id, block_key);
update notesdb.search_documents d
set block_key = b.block_key
from notesdb.note_blocks b
where d.note_id = b.note_id
  and d.owner_id = b.owner_id
  and d.source_type in ('copy_block', 'code_block')
  and split_part(d.source_key, ':chunk:', 1) = b.block_key
  and d.block_key is distinct from b.block_key;

create or replace function public.qnotes_utf8_prefix(p_value text, p_max_bytes integer)
returns text
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  result text := '';
  character text;
  character_index integer;
begin
  if p_value is null or p_max_bytes <= 0 then return ''; end if;
  for character_index in 1..char_length(p_value)
  loop
    character := substr(p_value, character_index, 1);
    exit when octet_length(result || character) > p_max_bytes;
    result := result || character;
  end loop;
  return result;
end;
$$;

create or replace function public.qnotes_embedding_text(p_value text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select btrim(replace(replace(coalesce(p_value, ''), chr(13) || chr(10), chr(10)), chr(13), chr(10)));
$$;

create or replace function public.qnotes_embedding_prefix(
  p_source_title text,
  p_heading_path text
) returns text
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  title text := public.qnotes_utf8_prefix(public.qnotes_embedding_text(p_source_title), 128);
  heading text := public.qnotes_utf8_prefix(public.qnotes_embedding_text(p_heading_path), 256);
begin
  if title = '' then return heading; end if;
  if heading = '' then return title; end if;
  return title || chr(10) || chr(10) || public.qnotes_utf8_prefix(heading, 256 - octet_length(title) - 2);
end;
$$;

create or replace function public.qnotes_embedding_input(
  p_source_title text,
  p_heading_path text,
  p_content text
) returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when public.qnotes_embedding_prefix(p_source_title, p_heading_path) = '' then public.qnotes_embedding_text(p_content)
    when public.qnotes_embedding_text(p_content) = '' then public.qnotes_embedding_prefix(p_source_title, p_heading_path)
    else public.qnotes_embedding_prefix(p_source_title, p_heading_path) || chr(10) || chr(10) || public.qnotes_embedding_text(p_content)
  end;
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
  select encode(digest(
    convert_to('v3', 'utf8') || decode('00', 'hex') ||
      convert_to(public.qnotes_embedding_input(p_source_title, p_heading_path, p_content), 'utf8'),
    'sha256'
  ), 'hex');
$$;

-- The model limit is 512 tokens. The byte ceiling is the conservative
-- tokenizer-independent boundary used by the Edge adapter, with 16 tokens
-- reserved for provider-added special tokens.
create or replace function public.qnotes_embedding_content_chunks(
  p_source_title text,
  p_heading_path text,
  p_content text
) returns table (chunk_index integer, content text)
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  normalized text := public.qnotes_embedding_text(p_content);
  prefix text := public.qnotes_embedding_prefix(p_source_title, p_heading_path);
  max_bytes integer := 496 - octet_length(prefix) - case when prefix = '' then 0 else 2 end;
  lines text[];
  line text;
  current text := '';
  candidate text;
  line_bytes bytea;
  part_bytes bytea;
  byte_offset integer;
  part text;
  number integer := 0;
begin
  if normalized = '' then return; end if;

  select coalesce(array_agg(value order by ordinality), '{}')
  into lines
  from unnest(string_to_array(normalized, chr(10))) with ordinality as split(value, ordinality)
  where btrim(value) <> '';

  foreach line in array lines
  loop
    if octet_length(line) > max_bytes then
      if current <> '' then
        chunk_index := number;
        content := current;
        number := number + 1;
        return next;
        current := '';
      end if;
      line_bytes := convert_to(line, 'utf8');
      byte_offset := 0;
      while byte_offset < octet_length(line_bytes) loop
        part_bytes := substring(line_bytes from byte_offset + 1 for max_bytes);
        loop
          begin
            part := convert_from(part_bytes, 'utf8');
            exit;
          exception when character_not_in_repertoire then
            part_bytes := substring(part_bytes from 1 for octet_length(part_bytes) - 1);
          end;
        end loop;
        if part = '' then raise exception 'embedding chunk budget cannot hold one UTF-8 character'; end if;
        chunk_index := number;
        content := part;
        number := number + 1;
        return next;
        byte_offset := byte_offset + octet_length(part_bytes);
      end loop;
      continue;
    end if;

    candidate := case when current = '' then line else current || chr(10) || line end;
    if current <> '' and octet_length(candidate) > max_bytes then
      chunk_index := number;
      content := current;
      number := number + 1;
      return next;
      current := line;
    else
      current := candidate;
    end if;
  end loop;

  if current <> '' then
    chunk_index := number;
    content := current;
    return next;
  end if;
end;
$$;

create or replace function public.qnotes_expand_embedding_documents(p_documents jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  item jsonb;
  chunk record;
  expanded jsonb := '[]'::jsonb;
  source_key text;
  source_title text;
  heading_path text;
  source_type text;
  content text;
  chunk_hash text;
  chunk_position integer;
  next_position integer := 0;
begin
  for item in select value from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb))
  loop
    source_key := coalesce(item->>'sourceKey', 'document');
    source_title := item->>'sourceTitle';
    heading_path := item->>'headingPath';
    source_type := coalesce(item->>'sourceType', 'note_chunk');
    content := coalesce(item->>'content', '');
    if octet_length(public.qnotes_embedding_input(source_title, heading_path, content)) <= 496 then
      expanded := expanded || jsonb_build_array(jsonb_set(item, '{position}', to_jsonb(next_position), true));
      next_position := next_position + 1;
      continue;
    end if;

    for chunk in select * from public.qnotes_embedding_content_chunks(source_title, heading_path, content)
    loop
      chunk_hash := encode(digest(chunk.content, 'sha256'), 'hex');
      chunk_position := next_position;
      next_position := next_position + 1;
      expanded := expanded || jsonb_build_array(jsonb_build_object(
        'sourceType', source_type,
        'sourceId', item->>'sourceId',
        'sourceKey', source_key || ':chunk:' || chunk.chunk_index::text || '-' || left(chunk_hash, 16),
        'blockKey', case when source_type in ('copy_block', 'code_block') then source_key else null end,
        'sourceTitle', source_title,
        'headingPath', heading_path,
        'content', chunk.content,
        'contentHash', chunk_hash,
        'position', chunk_position,
        'pageNumber', item->>'pageNumber'
      ));
    end loop;
  end loop;
  return expanded;
end;
$$;

-- Split metadata too; titles, tags and notebook names can exceed the provider
-- boundary even though the note body itself is already chunked.
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
  metadata_documents jsonb;
  item jsonb;
  existing notesdb.search_documents%rowtype;
  found_document boolean;
  should_enqueue boolean;
  document_id uuid;
  source_key_value text;
  content text;
  content_hash text;
  position_value integer;
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
  metadata_documents := public.qnotes_expand_embedding_documents(jsonb_build_array(jsonb_build_object(
    'sourceType', 'note_metadata',
    'sourceKey', 'metadata',
    'sourceTitle', note_row.title,
    'headingPath', null,
    'content', metadata_content,
    'contentHash', metadata_hash,
    'position', 0
  )));

  delete from notesdb.search_documents d
  where d.note_id = p_note_id
    and d.owner_id = p_owner_id
    and d.source_type = 'note_metadata'
    and not exists (
      select 1 from jsonb_array_elements(metadata_documents) x
      where x->>'sourceKey' = d.source_key
    );

  for item in select value from jsonb_array_elements(metadata_documents)
  loop
    source_key_value := item->>'sourceKey';
    content := coalesce(item->>'content', '');
    content_hash := item->>'contentHash';
    position_value := coalesce((item->>'position')::integer, 0);
    existing := null;
    select * into existing
    from notesdb.search_documents d
    where d.note_id = p_note_id
      and d.owner_id = p_owner_id
      and d.source_type = 'note_metadata'
      and d.source_key = source_key_value
    for update;
    found_document := found;
    should_enqueue := not found_document
      or (existing.embedding_status = 'failed'
        and existing.content_hash = content_hash
        and coalesce(existing.embedding_attempts, 0) > 0
        and coalesce(existing.embedding_attempts, 0) < 5);

    insert into notesdb.search_documents (
      owner_id, note_id, source_type, source_id, source_key, source_title,
      block_key, heading_path, content, content_hash, position, embedding_status
    ) values (
      p_owner_id, p_note_id, 'note_metadata', null, source_key_value,
      coalesce(item->>'sourceTitle', note_row.title), null, item->>'headingPath',
      content, content_hash, position_value, 'pending'
    )
    on conflict (note_id, source_type, source_key) do update set
      owner_id = excluded.owner_id,
      source_title = excluded.source_title,
      block_key = excluded.block_key,
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
end;
$$;

-- Apply the same expansion to direct attachment completion calls. This keeps
-- older workers and repair jobs inside the provider boundary as well.
create or replace function public.qnotes_complete_attachment_processing(p_owner_id uuid, p_attachment_id uuid, p_checksum_sha256 text, p_documents jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item notesdb.attachments%rowtype;
  document jsonb;
  expanded_documents jsonb;
  document_row notesdb.search_documents%rowtype;
begin
  select * into item
  from notesdb.attachments
  where id = p_attachment_id and owner_id = p_owner_id and deleted_at is null
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if not exists (select 1 from notesdb.notes where id = item.note_id and owner_id = p_owner_id and deleted_at is null) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceType', 'attachment_chunk',
    'sourceId', coalesce(value->>'sourceId', p_attachment_id::text),
    'sourceKey', value->>'sourceKey',
    'sourceTitle', coalesce(value->>'sourceTitle', item.original_file_name),
    'headingPath', value->>'headingPath',
    'content', coalesce(value->>'content', ''),
    'contentHash', value->>'contentHash',
    'position', coalesce((value->>'position')::integer, 0),
    'pageNumber', value->>'pageNumber'
  )), '[]'::jsonb)
  into expanded_documents
  from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb)) as documents(value);
  expanded_documents := public.qnotes_expand_embedding_documents(expanded_documents);

  delete from notesdb.search_documents
  where owner_id = p_owner_id
    and note_id = item.note_id
    and source_type = 'attachment_chunk'
    and (source_id = item.id or source_key like 'attachment:' || item.id::text || ':%');

  for document in select value from jsonb_array_elements(expanded_documents)
  loop
    insert into notesdb.search_documents (
      owner_id, note_id, source_type, source_id, source_key, source_title,
      heading_path, content, content_hash, position, page_number, embedding_status
    ) values (
      p_owner_id, item.note_id, 'attachment_chunk', item.id,
      document->>'sourceKey', coalesce(document->>'sourceTitle', item.original_file_name),
      document->>'headingPath', coalesce(document->>'content', ''),
      document->>'contentHash', coalesce((document->>'position')::integer, 0),
      nullif(document->>'pageNumber', '')::integer, 'pending'
    )
    returning * into document_row;
    perform public.qnotes_enqueue_embedding(document_row.id, p_owner_id, document_row.content_hash);
  end loop;

  update notesdb.attachments
  set checksum_sha256 = p_checksum_sha256,
      extraction_status = 'ready',
      extraction_error = null,
      updated_at = timezone('utc', now())
  where id = item.id;
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id);
end;
$$;

-- Keep the existing sync contract and make the SQL fallback obey the same
-- chunking boundary as the API parser.
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

  if jsonb_array_length(p_documents) = 0 then
    select case
      when n.content_plain <> '' then jsonb_build_array(jsonb_build_object(
        'sourceType', 'note_chunk',
        'sourceKey', 'note:full',
        'sourceTitle', n.title,
        'headingPath', n.title,
        'content', n.content_plain,
        'contentHash', encode(digest(n.content_plain, 'sha256'), 'hex'),
        'position', 0
      ))
      else '[]'::jsonb
    end
    into p_documents
    from notesdb.notes n
    where n.id = p_note_id and n.owner_id = p_owner_id;
    p_documents := coalesce(p_documents, '[]'::jsonb);
  end if;
  p_documents := public.qnotes_expand_embedding_documents(p_documents);

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
    and d.source_type in ('note_chunk', 'copy_block', 'code_block')
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
      or (existing.embedding_status = 'failed'
        and existing.content_hash = content_hash
        and coalesce(existing.embedding_attempts, 0) > 0
        and coalesce(existing.embedding_attempts, 0) < 5);

    insert into notesdb.search_documents (
      owner_id, note_id, source_type, source_id, source_key, source_title,
      block_key, heading_path, content, content_hash, position, embedding_status
    ) values (
      p_owner_id,
      p_note_id,
      source_type_value,
      nullif(item->>'sourceId', '')::uuid,
      source_key_value,
      source_title,
      nullif(item->>'blockKey', ''),
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
      block_key = excluded.block_key,
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

-- Reindex only a bounded batch of documents whose input generation is stale.
-- The trigger computes the current hash and enqueues the exact CAS identity.
create or replace function public.qnotes_requeue_embedding_generation(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  document_record record;
  blocks jsonb;
  documents jsonb;
  attachment_checksum text;
  processed_notes uuid[] := '{}';
  processed_attachments uuid[] := '{}';
  queued_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'embedding generation limit must be between 1 and 1000';
  end if;

  for document_record in
    select d.id, d.note_id, d.owner_id, d.source_type, d.source_id,
      d.source_key, d.source_title, d.heading_path, d.content, d.content_hash,
      d.position, d.page_number, d.embedding_input_hash
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
    where d.embedding_input_hash is distinct from public.qnotes_embedding_input_hash(d.source_title, d.heading_path, d.content)
      and (
        (d.source_type = 'attachment_chunk' and (
          select count(*) from notesdb.search_documents group_documents
          where group_documents.note_id = d.note_id
            and group_documents.owner_id = d.owner_id
            and group_documents.source_type = 'attachment_chunk'
            and group_documents.source_id = d.source_id
        ) <= p_limit)
        or (d.source_type <> 'attachment_chunk' and (
          select count(*) from notesdb.search_documents group_documents
          where group_documents.note_id = d.note_id
            and group_documents.owner_id = d.owner_id
            and group_documents.source_type <> 'attachment_chunk'
        ) <= p_limit)
      )
    order by d.id
    limit p_limit
  loop
    -- Direct attachment completion locks the attachment before replacing its
    -- documents; avoid holding a document row lock across that call.
    if not pg_try_advisory_xact_lock(hashtextextended(document_record.id::text, 0)) then
      continue;
    end if;
    if document_record.source_type <> 'attachment_chunk' then
      -- Match note updates' note-then-document lock order, then refresh the
      -- candidate after waiting so a stale snapshot cannot overwrite it.
      perform 1
      from notesdb.notes n
      where n.id = document_record.note_id
        and n.owner_id = document_record.owner_id
        and n.deleted_at is null
      for update;
      if not found then
        continue;
      end if;
      select d.id, d.note_id, d.owner_id, d.source_type, d.source_id,
        d.source_key, d.source_title, d.heading_path, d.content, d.content_hash,
        d.position, d.page_number, d.embedding_input_hash
      into document_record
      from notesdb.search_documents d
      where d.id = document_record.id
      for update;
      if not found or document_record.embedding_input_hash is not distinct from public.qnotes_embedding_input_hash(document_record.source_title, document_record.heading_path, document_record.content) then
        continue;
      end if;
    end if;
    if octet_length(public.qnotes_embedding_input(document_record.source_title, document_record.heading_path, document_record.content)) > 496 then
      if document_record.source_type = 'attachment_chunk' and document_record.source_id is not null then
        if not document_record.source_id = any(processed_attachments) then
          select a.checksum_sha256 into attachment_checksum
          from notesdb.attachments a
          where a.id = document_record.source_id
            and a.owner_id = document_record.owner_id
            and a.deleted_at is null
          for update;
          select coalesce(jsonb_agg(jsonb_build_object(
            'sourceId', d.source_id,
            'sourceKey', d.source_key,
            'sourceTitle', d.source_title,
            'headingPath', d.heading_path,
            'content', d.content,
            'contentHash', d.content_hash,
            'position', d.position,
            'pageNumber', d.page_number
          ) order by d.position, d.id), '[]'::jsonb)
          into documents
          from notesdb.search_documents d
          where d.note_id = document_record.note_id
            and d.owner_id = document_record.owner_id
            and d.source_type = 'attachment_chunk'
            and d.source_id = document_record.source_id;
          if attachment_checksum is not null then
            perform public.qnotes_complete_attachment_processing(document_record.owner_id, document_record.source_id, attachment_checksum, documents);
          else
            select coalesce(jsonb_agg(jsonb_build_object(
              'blockKey', b.block_key,
              'blockType', b.block_type,
              'title', b.title,
              'language', b.language,
              'content', b.content,
              'position', b.position,
              'copyable', b.copyable,
              'contentHash', b.content_hash
            ) order by b.position, b.id), '[]'::jsonb)
            into blocks
            from notesdb.note_blocks b
            where b.note_id = document_record.note_id and b.owner_id = document_record.owner_id;
            select coalesce(jsonb_agg(jsonb_build_object(
            'sourceType', d.source_type,
            'sourceId', d.source_id,
            'sourceKey', d.source_key,
            'blockKey', d.block_key,
            'sourceTitle', d.source_title,
              'headingPath', d.heading_path,
              'content', d.content,
              'contentHash', d.content_hash,
              'position', d.position,
              'pageNumber', d.page_number
            ) order by d.position, d.id), '[]'::jsonb)
            into documents
            from notesdb.search_documents d
            where d.note_id = document_record.note_id
              and d.owner_id = document_record.owner_id
              and d.source_type <> 'attachment_chunk';
            perform public.qnotes_sync_note_content(document_record.note_id, document_record.owner_id, blocks, documents);
          end if;
          processed_attachments := array_append(processed_attachments, document_record.source_id);
          queued_count := queued_count + 1;
        end if;
      elsif not document_record.note_id = any(processed_notes) then
        select coalesce(jsonb_agg(jsonb_build_object(
          'blockKey', b.block_key,
          'blockType', b.block_type,
          'title', b.title,
          'language', b.language,
          'content', b.content,
          'position', b.position,
          'copyable', b.copyable,
          'contentHash', b.content_hash
        ) order by b.position, b.id), '[]'::jsonb)
        into blocks
        from notesdb.note_blocks b
        where b.note_id = document_record.note_id and b.owner_id = document_record.owner_id;
        select coalesce(jsonb_agg(jsonb_build_object(
          'sourceType', d.source_type,
          'sourceId', d.source_id,
          'sourceKey', d.source_key,
          'blockKey', d.block_key,
          'sourceTitle', d.source_title,
          'headingPath', d.heading_path,
          'content', d.content,
          'contentHash', d.content_hash,
          'position', d.position,
          'pageNumber', d.page_number
        ) order by d.position, d.id), '[]'::jsonb)
        into documents
        from notesdb.search_documents d
        where d.note_id = document_record.note_id
          and d.owner_id = document_record.owner_id
          and d.source_type <> 'attachment_chunk';
        perform public.qnotes_sync_note_content(document_record.note_id, document_record.owner_id, blocks, documents);
        processed_notes := array_append(processed_notes, document_record.note_id);
        queued_count := queued_count + 1;
      end if;
    else
      update notesdb.search_documents
      set embedding = null,
          embedding_status = 'pending',
          embedding_error = null,
          embedding_attempts = 0,
          embedding_mode = 'provider',
          embedding_queued_at = timezone('utc', now())
      where id = document_record.id;
      queued_count := queued_count + 1;
    end if;
  end loop;
  return queued_count;
end;
$$;

-- Keep every search surface joined to the persisted parent block key. The
-- function bodies predate the column, so reapply them after the data repair.
do $$
declare
  signature text;
  definition text;
begin
  foreach signature in array array[
    'qnotes_keyword_search(uuid,text,integer,jsonb,integer,integer)',
    'qnotes_semantic_search(uuid,text,extensions.vector,integer,jsonb,integer,integer)',
    'qnotes_keyword_search_scoped(uuid,text,integer,jsonb,integer,integer,uuid[],boolean)',
    'qnotes_semantic_search_scoped(uuid,text,extensions.vector,integer,jsonb,integer,integer,uuid[],boolean)'
  ]
  loop
    select pg_get_functiondef(p.oid)
    into definition
    from pg_proc p
    where p.oid = (format('public.%s', signature))::regprocedure;
    if definition is null then
      raise exception 'search function % does not exist', signature;
    end if;
    definition := replace(definition, 'b.block_key = d.source_key', 'b.block_key = coalesce(d.block_key, d.source_key)');
    definition := replace(definition, 'b.block_key, b.language', 'coalesce(d.block_key, b.block_key) as block_key, b.language');
    execute definition;
  end loop;
end;
$$;

revoke all on function public.qnotes_utf8_prefix(text, integer) from public, anon, authenticated;
revoke all on function public.qnotes_embedding_text(text) from public, anon, authenticated;
revoke all on function public.qnotes_embedding_prefix(text, text) from public, anon, authenticated;
revoke all on function public.qnotes_embedding_content_chunks(text, text, text) from public, anon, authenticated;
revoke all on function public.qnotes_expand_embedding_documents(jsonb) from public, anon, authenticated;
revoke all on function public.qnotes_requeue_embedding_generation(integer) from public, anon, authenticated;
grant execute on function public.qnotes_requeue_embedding_generation(integer) to service_role;
revoke all on function public.qnotes_sync_note_content(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qnotes_sync_note_content(uuid, uuid, jsonb, jsonb) to service_role;
-- The four-argument attachment completion overload remains for older workers;
-- keep its compatibility path service-only as well.
revoke all on function public.qnotes_complete_attachment_processing(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.qnotes_complete_attachment_processing(uuid, uuid, text, jsonb) to service_role;
