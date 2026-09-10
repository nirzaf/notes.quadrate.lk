-- Preserve attachment-owned search documents during note replacement.
-- Repair execution is intentionally separate from this schema/function change;
-- run the report in staging first and use an explicit operation ID for any
-- approved bounded requeue.

create table if not exists notesdb.attachment_search_repairs (
  operation_id uuid not null,
  attachment_id uuid not null references notesdb.attachments(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references notesdb.notes(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (operation_id, attachment_id)
);

alter table notesdb.attachment_search_repairs enable row level security;
revoke all on table notesdb.attachment_search_repairs from public, anon, authenticated;
grant all on table notesdb.attachment_search_repairs to service_role;

create index if not exists attachment_search_repairs_attachment_key
  on notesdb.attachment_search_repairs (attachment_id, created_at);

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

create or replace function public.qnotes_remove_attachment_search_documents()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    delete from notesdb.search_documents
    where owner_id = new.owner_id
      and note_id = new.note_id
      and source_type = 'attachment_chunk'
      and (source_id = new.id or source_key like 'attachment:' || new.id::text || ':%');
  end if;
  return new;
end;
$$;

drop trigger if exists attachments_search_documents_after_delete on notesdb.attachments;
create trigger attachments_search_documents_after_delete
after update of deleted_at on notesdb.attachments
for each row execute function public.qnotes_remove_attachment_search_documents();

revoke all on function public.qnotes_remove_attachment_search_documents() from public, anon, authenticated;
grant execute on function public.qnotes_remove_attachment_search_documents() to service_role;



create or replace function public.qnotes_repair_attachment_search(
  p_operation_id uuid default null,
  p_dry_run boolean default true,
  p_batch_size integer default 100
)
returns table (
  operation_id uuid,
  attachment_id uuid,
  owner_id uuid,
  note_id uuid,
  action text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  candidate record;
  inserted boolean;
begin
  if p_dry_run is null then
    raise exception using message = 'dry_run is required';
  end if;
  if p_dry_run then
    p_operation_id := coalesce(p_operation_id, gen_random_uuid());
  elsif p_operation_id is null then
    raise exception using message = 'operation_id is required for mutating repair';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception using message = 'batch_size must be between 1 and 1000';
  end if;

  -- Only a ready, checksum-bound attachment with no attachment chunks is
  -- repairable. Failed, unsupported, empty, deleted, and deleted-note rows
  -- stay out of the queue so a legitimate non-extractable file cannot loop.
  for candidate in
    select a.id as attachment_id, a.owner_id, a.note_id
    from notesdb.attachments a
    join notesdb.notes n
      on n.id = a.note_id
      and n.owner_id = a.owner_id
      and n.deleted_at is null
    where a.deleted_at is null
      and a.extraction_status = 'ready'
      and a.checksum_sha256 is not null
      and a.extraction_error is null
      and not exists (
        select 1
        from notesdb.search_documents d
        where d.owner_id = a.owner_id
          and d.note_id = a.note_id
          and d.source_type = 'attachment_chunk'
          and (d.source_id = a.id or d.source_key like 'attachment:' || a.id::text || ':%')
      )
    order by a.id
    limit p_batch_size
  loop
    operation_id := p_operation_id;
    attachment_id := candidate.attachment_id;
    owner_id := candidate.owner_id;
    note_id := candidate.note_id;

    if p_dry_run then
      action := 'would_requeue';
    else
      insert into notesdb.attachment_search_repairs (operation_id, attachment_id, owner_id, note_id)
      values (p_operation_id, candidate.attachment_id, candidate.owner_id, candidate.note_id)
      on conflict on constraint attachment_search_repairs_pkey do nothing;
      inserted := found;
      if inserted then
        perform pgmq.send('attachment-processing', jsonb_build_object(
          'attachmentId', candidate.attachment_id,
          'ownerId', candidate.owner_id,
          'repairOperationId', p_operation_id
        ));
        action := 'requeued';
      else
        action := 'already_recorded';
      end if;
    end if;

    return next;
  end loop;
end;
$$;

revoke all on function public.qnotes_repair_attachment_search(uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.qnotes_repair_attachment_search(uuid, boolean, integer) to service_role;

-- Staging dry run:
-- select * from public.qnotes_repair_attachment_search('<operation-id>', true, 100);
-- Approved bounded requeue:
-- select * from public.qnotes_repair_attachment_search('<same-operation-id>', false, 100);
