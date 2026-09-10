begin;

alter table notesdb.attachments
  add column if not exists storage_mode text not null default 'legacy',
  add column if not exists staging_object_path text,
  add column if not exists object_generation uuid not null default gen_random_uuid(),
  add column if not exists verified_at timestamptz,
  add column if not exists staging_expires_at timestamptz,
  add column if not exists cleanup_attempts integer not null default 0,
  add column if not exists cleanup_next_at timestamptz not null default timezone('utc', now());

alter table notesdb.attachments drop constraint if exists attachments_status_check;
alter table notesdb.attachments
  add constraint attachments_status_check check (extraction_status in ('pending_upload', 'uploaded', 'verifying', 'queued', 'processing', 'ready', 'failed', 'unsupported', 'deleting', 'deleted')),
  add constraint attachments_storage_mode_check check (storage_mode in ('legacy', 'immutable')),
  add constraint attachments_cleanup_attempts_check check (cleanup_attempts >= 0),
  add constraint attachments_immutable_metadata_check check (
    storage_mode = 'legacy'
    or (
      object_generation is not null
      and (staging_object_path is null or staging_object_path <> object_path)
      and (extraction_status not in ('pending_upload', 'verifying') or staging_object_path is not null)
      and (
          extraction_status in ('pending_upload', 'verifying', 'failed', 'unsupported', 'deleting', 'deleted')
          or (
            extraction_status in ('queued', 'processing', 'ready')
            and checksum_sha256 is not null
            and checksum_sha256 ~ '^[a-f0-9]{64}$'
            and verified_at is not null
        )
      )
    )
  );

create unique index if not exists attachments_staging_object_path_key
  on notesdb.attachments (staging_object_path)
  where staging_object_path is not null;

create index if not exists attachments_cleanup_key
  on notesdb.attachments (extraction_status, cleanup_next_at)
  where deleted_at is not null or staging_object_path is not null;

drop policy if exists note_attachments_insert on storage.objects;
drop policy if exists note_attachments_update on storage.objects;
drop policy if exists note_attachments_delete on storage.objects;

create policy note_attachments_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'note-attachments'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and split_part(name, '/', 3) = 'staging'
  and exists (
    select 1
    from notesdb.attachments a
    where a.owner_id = (select auth.uid())
      and a.staging_object_path = name
      and a.deleted_at is null
      and a.extraction_status = 'pending_upload'
  )
);

create policy note_attachments_update on storage.objects
for update to authenticated
using (
  bucket_id = 'note-attachments'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and false
)
with check (
  bucket_id = 'note-attachments'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and false
);

create policy note_attachments_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'note-attachments'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and split_part(name, '/', 3) = 'staging'
  and exists (
    select 1
    from notesdb.attachments a
    where a.owner_id = (select auth.uid())
      and a.staging_object_path = name
      and a.deleted_at is null
      and a.extraction_status in ('pending_upload', 'failed')
  )
);

drop function if exists public.qnotes_finalize_attachment(uuid, uuid);
drop function if exists public.qnotes_complete_attachment_processing(uuid, uuid, text, jsonb);

create or replace function public.qnotes_begin_attachment_verification(p_owner_id uuid, p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item notesdb.attachments%rowtype;
begin
  select * into item
  from notesdb.attachments
  where id = p_attachment_id and owner_id = p_owner_id
  for update;
  if not found or item.deleted_at is not null then
    return jsonb_build_object('status', 'not_found', 'claimed', false);
  end if;
  if item.extraction_status = 'pending_upload' and item.staging_expires_at is not null and item.staging_expires_at <= timezone('utc', now()) then
    update notesdb.attachments
    set extraction_status = 'deleting', deleted_at = timezone('utc', now()), extraction_error = 'UPLOAD_EXPIRED', cleanup_next_at = timezone('utc', now()), updated_at = timezone('utc', now())
    where id = item.id;
    return jsonb_build_object('status', 'expired', 'claimed', false);
  end if;
  if item.extraction_status = 'pending_upload' then
    update notesdb.attachments
    set extraction_status = 'verifying', extraction_error = null, updated_at = timezone('utc', now())
    where id = item.id
    returning * into item;
    return jsonb_build_object('status', 'verifying', 'claimed', true, 'generation', item.object_generation, 'stagingPath', coalesce(item.staging_object_path, item.object_path), 'objectPath', item.object_path);
  end if;
  return jsonb_build_object('status', item.extraction_status, 'claimed', false, 'generation', item.object_generation, 'stagingPath', coalesce(item.staging_object_path, item.object_path), 'objectPath', item.object_path);
end;
$$;

create or replace function public.qnotes_finalize_attachment(p_owner_id uuid, p_attachment_id uuid, p_checksum_sha256 text, p_generation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item notesdb.attachments%rowtype;
begin
  select * into item
  from notesdb.attachments
  where id = p_attachment_id and owner_id = p_owner_id and deleted_at is null
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_generation is null or item.object_generation <> p_generation then return jsonb_build_object('status', 'generation_conflict'); end if;
  if item.extraction_status in ('queued', 'processing', 'ready') then
    return jsonb_build_object('status', item.extraction_status, 'attachmentId', item.id);
  end if;
  if item.extraction_status <> 'verifying' then return jsonb_build_object('status', item.extraction_status); end if;
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status', 'invalid_checksum'); end if;
  update notesdb.attachments
  set storage_mode = 'immutable', checksum_sha256 = p_checksum_sha256, verified_at = timezone('utc', now()), extraction_status = 'queued', extraction_error = null, staging_expires_at = timezone('utc', now()), cleanup_attempts = 0, cleanup_next_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where id = item.id
  returning * into item;
  perform pgmq.send('attachment-processing', jsonb_build_object('attachmentId', item.id, 'ownerId', p_owner_id, 'generation', item.object_generation));
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id, 'generation', item.object_generation);
end;
$$;

create or replace function public.qnotes_complete_attachment_processing(p_owner_id uuid, p_attachment_id uuid, p_generation uuid, p_checksum_sha256 text, p_documents jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item notesdb.attachments%rowtype;
  document jsonb;
  document_row notesdb.search_documents%rowtype;
begin
  select * into item
  from notesdb.attachments
  where id = p_attachment_id and owner_id = p_owner_id and deleted_at is null and extraction_status = 'processing'
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_generation is null or p_checksum_sha256 is null or item.object_generation <> p_generation or (item.storage_mode = 'immutable' and item.checksum_sha256 is distinct from p_checksum_sha256) or p_checksum_sha256 !~ '^[a-f0-9]{64}$' then return jsonb_build_object('status', 'integrity_conflict'); end if;
  if not exists (select 1 from notesdb.notes where id = item.note_id and owner_id = p_owner_id and deleted_at is null) then return jsonb_build_object('status', 'not_found'); end if;
  delete from notesdb.search_documents where owner_id = p_owner_id and note_id = item.note_id and source_type = 'attachment_chunk' and source_key like 'attachment:' || item.id::text || ':%';
  for document in select value from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb))
  loop
    insert into notesdb.search_documents (owner_id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, embedding_status)
    values (p_owner_id, item.note_id, 'attachment_chunk', item.id, document->>'sourceKey', coalesce(document->>'sourceTitle', item.original_file_name), document->>'headingPath', coalesce(document->>'content', ''), document->>'contentHash', (document->>'position')::integer, 'pending')
    returning * into document_row;
    perform public.qnotes_enqueue_embedding(document_row.id, p_owner_id, document_row.content_hash);
  end loop;
  update notesdb.attachments
  set storage_mode = 'immutable', checksum_sha256 = p_checksum_sha256, verified_at = coalesce(verified_at, timezone('utc', now())), extraction_status = 'ready', extraction_error = null, updated_at = timezone('utc', now())
  where id = item.id;
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id, 'generation', item.object_generation);
end;
$$;

create or replace function public.qnotes_requeue_stale_attachment_processing(
  p_stale_after interval default interval '15 minutes',
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  attachment_record record;
  queued_count integer := 0;
begin
  if p_stale_after is null or p_stale_after < interval '0 seconds' then
    return 0;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'attachment recovery limit must be between 1 and 1000';
  end if;

  for attachment_record in
    select a.id, a.owner_id, a.object_generation
    from notesdb.attachments a
    where a.extraction_status = 'processing'
      and a.deleted_at is null
      and a.updated_at <= timezone('utc', now()) - p_stale_after
    order by a.updated_at, a.id
    limit p_limit
    for update of a skip locked
  loop
    update notesdb.attachments
    set extraction_status = 'queued', extraction_error = null, updated_at = timezone('utc', now())
    where id = attachment_record.id;
    perform pgmq.send('attachment-processing', jsonb_build_object(
      'attachmentId', attachment_record.id,
      'ownerId', attachment_record.owner_id,
      'generation', attachment_record.object_generation
    ));
    queued_count := queued_count + 1;
  end loop;
  return queued_count;
end;
$$;

create or replace function public.qnotes_request_attachment_deletion(p_owner_id uuid, p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item notesdb.attachments%rowtype;
begin
  select * into item from notesdb.attachments where id = p_attachment_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if item.deleted_at is null then
    update notesdb.attachments
    set extraction_status = 'deleting', deleted_at = timezone('utc', now()), extraction_error = null, cleanup_attempts = 0, cleanup_next_at = timezone('utc', now()), updated_at = timezone('utc', now())
    where id = item.id
    returning * into item;
  end if;
  return jsonb_build_object('status', item.extraction_status, 'attachmentId', item.id, 'bucket', item.bucket, 'objectPath', item.object_path, 'stagingPath', item.staging_object_path);
end;
$$;

create or replace function public.qnotes_complete_attachment_deletion(p_owner_id uuid, p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  item notesdb.attachments%rowtype;
begin
  update notesdb.attachments
  set extraction_status = 'deleted', staging_object_path = null, staging_expires_at = null, extraction_error = null, updated_at = timezone('utc', now())
  where id = p_attachment_id and owner_id = p_owner_id and deleted_at is not null
  returning * into item;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok', 'attachmentId', item.id);
end;
$$;

revoke all on function public.qnotes_begin_attachment_verification(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_finalize_attachment(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_complete_attachment_processing(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.qnotes_requeue_stale_attachment_processing(interval, integer) from public, anon, authenticated;
revoke all on function public.qnotes_request_attachment_deletion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_complete_attachment_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qnotes_begin_attachment_verification(uuid, uuid) to service_role;
grant execute on function public.qnotes_finalize_attachment(uuid, uuid, text, uuid) to service_role;
grant execute on function public.qnotes_complete_attachment_processing(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.qnotes_requeue_stale_attachment_processing(interval, integer) to service_role;
grant execute on function public.qnotes_request_attachment_deletion(uuid, uuid) to service_role;
grant execute on function public.qnotes_complete_attachment_deletion(uuid, uuid) to service_role;

commit;
