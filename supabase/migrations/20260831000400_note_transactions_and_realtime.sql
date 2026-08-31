create or replace function public.qnotes_note_json(p_note public.notes)
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
    'version', p_note.version,
    'createdAt', p_note.created_at,
    'updatedAt', p_note.updated_at,
    'deletedAt', p_note.deleted_at
  );
$$;

create or replace function public.qnotes_blocks_json(p_note_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id,
    'noteId', b.note_id,
    'blockKey', b.block_key,
    'blockType', b.block_type,
    'title', b.title,
    'language', b.language,
    'content', b.content,
    'position', b.position,
    'copyable', b.copyable,
    'contentHash', b.content_hash
  ) order by b.position), '[]'::jsonb)
  from public.note_blocks b
  where b.note_id = p_note_id;
$$;

create or replace function public.qnotes_enqueue_embedding(p_document_id uuid, p_owner_id uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform pgmq.send('note-embeddings', jsonb_build_object(
    'searchDocumentId', p_document_id,
    'ownerId', p_owner_id,
    'contentHash', p_hash
  ));
end;
$$;

create or replace function public.qnotes_sync_note_content(p_note_id uuid, p_owner_id uuid, p_blocks jsonb, p_documents jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item jsonb;
  existing public.search_documents%rowtype;
  found_document boolean;
  should_enqueue boolean;
  document_id uuid;
  source_type text;
  source_key text;
  source_title text;
  heading_path text;
  content text;
  content_hash text;
  position_value integer;
begin
  p_blocks := coalesce(p_blocks, '[]'::jsonb);
  p_documents := coalesce(p_documents, '[]'::jsonb);

  delete from public.note_blocks b
  where b.note_id = p_note_id
    and not exists (
      select 1 from jsonb_array_elements(p_blocks) x
      where x->>'blockKey' = b.block_key
    );

  for item in select value from jsonb_array_elements(p_blocks)
  loop
    insert into public.note_blocks (owner_id, note_id, block_key, block_type, title, language, content, position, copyable, content_hash)
    values (
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

  delete from public.search_documents d
  where d.note_id = p_note_id
    and not exists (
      select 1 from jsonb_array_elements(p_documents) x
      where x->>'sourceType' = d.source_type and x->>'sourceKey' = d.source_key
    );

  for item in select value from jsonb_array_elements(p_documents)
  loop
    source_type := item->>'sourceType';
    source_key := item->>'sourceKey';
    source_title := coalesce(item->>'sourceTitle', '');
    heading_path := item->>'headingPath';
    content := coalesce(item->>'content', '');
    content_hash := item->>'contentHash';
    position_value := (item->>'position')::integer;
    existing := null;
    select * into existing
    from public.search_documents d
    where d.note_id = p_note_id and d.source_type = source_type and d.source_key = source_key
    for update;
    found_document := found;
    should_enqueue := not found_document or existing.content_hash is distinct from content_hash or existing.embedding_status = 'failed';

    insert into public.search_documents (owner_id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, embedding_status)
    values (p_owner_id, p_note_id, source_type, nullif(item->>'sourceId', '')::uuid, source_key, source_title, heading_path, content, content_hash, position_value, 'pending')
    on conflict (note_id, source_type, source_key) do update set
      owner_id = excluded.owner_id,
      source_id = excluded.source_id,
      source_title = excluded.source_title,
      heading_path = excluded.heading_path,
      content = excluded.content,
      content_hash = excluded.content_hash,
      position = excluded.position,
      embedding = case when public.search_documents.content_hash = excluded.content_hash and public.search_documents.embedding_status = 'ready' then public.search_documents.embedding else null end,
      embedding_status = case when public.search_documents.content_hash = excluded.content_hash and public.search_documents.embedding_status = 'ready' then 'ready' else 'pending' end,
      embedding_error = case when public.search_documents.content_hash = excluded.content_hash and public.search_documents.embedding_status = 'ready' then public.search_documents.embedding_error else null end,
      embedding_model = case when public.search_documents.content_hash = excluded.content_hash and public.search_documents.embedding_status = 'ready' then public.search_documents.embedding_model else null end
    returning id into document_id;

    if should_enqueue then
      perform public.qnotes_enqueue_embedding(document_id, p_owner_id, content_hash);
    end if;
  end loop;
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
declare
  stored public.note_mutations%rowtype;
  note_row public.notes%rowtype;
  response jsonb;
begin
  select * into stored from public.note_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  if exists (select 1 from public.notes where owner_id = p_owner_id and deleted_at is null and lower(slug) = lower(p_slug)) then
    return jsonb_build_object('status', 'slug_conflict');
  end if;
  insert into public.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, version, last_mutation_id, updated_by_device_id)
  values (p_note_id, p_owner_id, p_slug, p_title, p_content_markdown, p_content_plain, coalesce(p_tags, '{}'), 1, p_mutation_id, p_device_id)
  returning * into note_row;
  perform public.qnotes_sync_note_content(p_note_id, p_owner_id, p_blocks, p_documents);
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into public.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'created', p_request_hash, p_note_id, 1, response);
  return jsonb_build_object('status', 'ok') || response;
exception when unique_violation then
  if exists (select 1 from public.notes where owner_id = p_owner_id and deleted_at is null and lower(slug) = lower(p_slug)) then
    return jsonb_build_object('status', 'slug_conflict');
  end if;
  raise;
end;
$$;

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
  stored public.note_mutations%rowtype;
  note_row public.notes%rowtype;
  response jsonb;
begin
  select * into stored from public.note_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.request_hash = p_request_hash then
      return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks');
    end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  select * into note_row from public.notes where id = p_note_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if note_row.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version, 'currentNote', public.qnotes_note_json(note_row));
  end if;
  if exists (select 1 from public.notes where owner_id = p_owner_id and id <> p_note_id and deleted_at is null and lower(slug) = lower(p_slug)) then
    return jsonb_build_object('status', 'slug_conflict');
  end if;
  update public.notes
  set slug = p_slug, title = p_title, content_markdown = p_content_markdown, content_plain = p_content_plain,
      tags = coalesce(p_tags, '{}'), version = version + 1, last_mutation_id = p_mutation_id,
      updated_by_device_id = p_device_id, updated_at = timezone('utc', now())
  where id = p_note_id and owner_id = p_owner_id and version = p_expected_version
  returning * into note_row;
  perform public.qnotes_sync_note_content(p_note_id, p_owner_id, p_blocks, p_documents);
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into public.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response)
  values (p_owner_id, p_mutation_id, 'updated', p_request_hash, p_note_id, note_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_soft_delete_note(p_owner_id uuid, p_note_id uuid, p_expected_version bigint, p_device_id uuid, p_mutation_id uuid, p_request_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored public.note_mutations%rowtype;
  note_row public.notes%rowtype;
  response jsonb;
begin
  select * into stored from public.note_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.request_hash = p_request_hash then return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks'); end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  select * into note_row from public.notes where id = p_note_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if note_row.version <> p_expected_version then return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version, 'currentNote', public.qnotes_note_json(note_row)); end if;
  update public.notes set deleted_at = timezone('utc', now()), version = version + 1, last_mutation_id = p_mutation_id, updated_by_device_id = p_device_id, updated_at = timezone('utc', now()) where id = p_note_id and owner_id = p_owner_id returning * into note_row;
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into public.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response) values (p_owner_id, p_mutation_id, 'deleted', p_request_hash, p_note_id, note_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_restore_note(p_owner_id uuid, p_note_id uuid, p_expected_version bigint, p_device_id uuid, p_mutation_id uuid, p_request_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored public.note_mutations%rowtype;
  note_row public.notes%rowtype;
  response jsonb;
begin
  select * into stored from public.note_mutations where owner_id = p_owner_id and mutation_id = p_mutation_id for update;
  if found then
    if stored.request_hash = p_request_hash then return jsonb_build_object('status', 'idempotent', 'note', stored.response->'note', 'blocks', stored.response->'blocks'); end if;
    return jsonb_build_object('status', 'mutation_reuse_conflict');
  end if;
  select * into note_row from public.notes where id = p_note_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if note_row.version <> p_expected_version then return jsonb_build_object('status', 'version_conflict', 'currentVersion', note_row.version, 'currentNote', public.qnotes_note_json(note_row)); end if;
  if exists (select 1 from public.notes where owner_id = p_owner_id and id <> p_note_id and deleted_at is null and lower(slug) = lower(note_row.slug)) then return jsonb_build_object('status', 'slug_conflict'); end if;
  update public.notes set deleted_at = null, version = version + 1, last_mutation_id = p_mutation_id, updated_by_device_id = p_device_id, updated_at = timezone('utc', now()) where id = p_note_id and owner_id = p_owner_id returning * into note_row;
  response := jsonb_build_object('note', public.qnotes_note_json(note_row), 'blocks', public.qnotes_blocks_json(p_note_id));
  insert into public.note_mutations (owner_id, mutation_id, operation, request_hash, note_id, resulting_version, response) values (p_owner_id, p_mutation_id, 'restored', p_request_hash, p_note_id, note_row.version, response);
  return jsonb_build_object('status', 'ok') || response;
end;
$$;

create or replace function public.qnotes_finalize_attachment(p_owner_id uuid, p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item public.attachments%rowtype;
begin
  select * into item from public.attachments where id = p_attachment_id and owner_id = p_owner_id and deleted_at is null for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if item.extraction_status <> 'pending_upload' then return jsonb_build_object('status', item.extraction_status, 'attachmentId', item.id); end if;
  update public.attachments set extraction_status = 'queued', updated_at = timezone('utc', now()) where id = item.id returning * into item;
  perform pgmq.send('attachment-processing', jsonb_build_object('attachmentId', item.id, 'ownerId', p_owner_id));
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id);
end;
$$;

create or replace function public.qnotes_complete_attachment_processing(p_owner_id uuid, p_attachment_id uuid, p_checksum_sha256 text, p_documents jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item public.attachments%rowtype;
  document jsonb;
  document_row public.search_documents%rowtype;
begin
  select * into item from public.attachments where id = p_attachment_id and owner_id = p_owner_id and deleted_at is null for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if not exists (select 1 from public.notes where id = item.note_id and owner_id = p_owner_id and deleted_at is null) then return jsonb_build_object('status', 'not_found'); end if;
  delete from public.search_documents where owner_id = p_owner_id and note_id = item.note_id and source_type = 'attachment_chunk' and source_key like 'attachment:' || item.id::text || ':%';
  for document in select value from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb))
  loop
    insert into public.search_documents (owner_id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, embedding_status)
    values (p_owner_id, item.note_id, 'attachment_chunk', item.id, document->>'sourceKey', coalesce(document->>'sourceTitle', item.original_file_name), document->>'headingPath', coalesce(document->>'content', ''), document->>'contentHash', (document->>'position')::integer, 'pending')
    returning * into document_row;
    perform public.qnotes_enqueue_embedding(document_row.id, p_owner_id, document_row.content_hash);
  end loop;
  update public.attachments set checksum_sha256 = p_checksum_sha256, extraction_status = 'ready', extraction_error = null, updated_at = timezone('utc', now()) where id = item.id;
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id);
end;
$$;

create or replace function public.qnotes_fail_attachment_processing(p_owner_id uuid, p_attachment_id uuid, p_status text, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item public.attachments%rowtype;
begin
  update public.attachments set extraction_status = p_status, extraction_error = p_error, updated_at = timezone('utc', now()) where id = p_attachment_id and owner_id = p_owner_id and deleted_at is null returning * into item;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id);
end;
$$;

create or replace function public.qnotes_note_realtime_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_name text;
  payload jsonb;
begin
  if tg_op = 'INSERT' then
    action_name := 'created';
  elsif old.deleted_at is null and new.deleted_at is not null then
    action_name := 'deleted';
  elsif old.deleted_at is not null and new.deleted_at is null then
    action_name := 'restored';
  else
    action_name := 'updated';
  end if;
  payload := jsonb_build_object(
    'schemaVersion', 1,
    'entity', 'note',
    'action', action_name,
    'noteId', new.id,
    'version', new.version,
    'updatedAt', new.updated_at,
    'sourceDeviceId', new.updated_by_device_id,
    'mutationId', new.last_mutation_id
  );
  perform realtime.send(payload, 'note.changed', 'user:' || new.owner_id::text || ':notes', true);
  return new;
end;
$$;

create trigger notes_realtime_after_change after insert or update on public.notes
for each row execute function public.qnotes_note_realtime_event();

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'qnotes_create_note(uuid,uuid,text,text,text,text,text[],uuid,uuid,text,jsonb,jsonb)',
    'qnotes_update_note(uuid,uuid,text,text,text,text,text[],bigint,uuid,uuid,text,jsonb,jsonb)',
    'qnotes_soft_delete_note(uuid,uuid,bigint,uuid,uuid,text)',
    'qnotes_restore_note(uuid,uuid,bigint,uuid,uuid,text)',
    'qnotes_finalize_attachment(uuid,uuid)',
    'qnotes_complete_attachment_processing(uuid,uuid,text,jsonb)',
    'qnotes_fail_attachment_processing(uuid,uuid,text,text)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', signature);
    execute format('grant execute on function public.%s to service_role', signature);
  end loop;
end;
$$;
