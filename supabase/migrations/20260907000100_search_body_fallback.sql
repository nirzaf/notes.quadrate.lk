-- Keep direct note-body search available for older or minimal clients that do
-- not send parsed note_chunk documents with a mutation.

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

