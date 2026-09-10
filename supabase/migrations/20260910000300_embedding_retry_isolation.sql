-- Keep provider attempts separate from pgmq read counts. A message can be
-- leased repeatedly without ever reaching the provider, so read_ct is not a
-- retry budget.

alter table notesdb.search_documents
  add column if not exists embedding_attempts integer not null default 0,
  add column if not exists embedding_mode text not null default 'provider';

alter table notesdb.search_documents
  drop constraint if exists search_documents_embedding_attempts_check;
alter table notesdb.search_documents
  add constraint search_documents_embedding_attempts_check check (embedding_attempts >= 0);

alter table notesdb.search_documents
  drop constraint if exists search_documents_embedding_mode_check;
alter table notesdb.search_documents
  add constraint search_documents_embedding_mode_check check (embedding_mode in ('provider', 'synthetic-test-v1'));

create index if not exists search_documents_embedding_retry_key
  on notesdb.search_documents (embedding_status, embedding_attempts, embedding_queued_at, id);

create or replace function public.qnotes_reset_embedding_retry_state()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    new.embedding_attempts := 0;
    new.embedding_mode := 'provider';
  elsif old.content_hash is distinct from new.content_hash
    or old.embedding_input_hash is distinct from new.embedding_input_hash
    or old.embedding_model is distinct from new.embedding_model
    or old.embedding_model_version is distinct from new.embedding_model_version
  then
    new.embedding_attempts := 0;
    new.embedding_mode := 'provider';
  end if;
  return new;
end;
$$;

drop trigger if exists search_documents_reset_embedding_retry_state on notesdb.search_documents;
create trigger search_documents_reset_embedding_retry_state
before insert or update on notesdb.search_documents
for each row execute function public.qnotes_reset_embedding_retry_state();

revoke all on function public.qnotes_reset_embedding_retry_state() from public, anon, authenticated;
grant execute on function public.qnotes_reset_embedding_retry_state() to service_role;

-- Re-apply the provider queue guards after the retry state exists. A terminal
-- failure is only requeued through the bounded operator function below.
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
declare
  changed_rows integer;
begin
  update notesdb.search_documents
  set embedding_queued_at = timezone('utc', now())
  where id = p_document_id
    and owner_id = p_owner_id
    and content_hash = p_hash
    and embedding_input_hash = p_input_hash
    and embedding_status in ('pending', 'failed')
    and embedding_attempts < 5
    and embedding_model = 'gte-small'
    and embedding_model_version = p_model_version;
  get diagnostics changed_rows = row_count;
  if changed_rows = 0 then return; end if;

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
  model_version text;
begin
  select d.embedding_input_hash, d.embedding_model_version
  into input_hash, model_version
  from notesdb.search_documents d
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.content_hash = p_hash
    and d.embedding_status in ('pending', 'failed')
    and d.embedding_attempts < 5;
  if input_hash is null then return; end if;
  perform public.qnotes_enqueue_embedding(p_document_id, p_owner_id, p_hash, input_hash, coalesce(model_version, 'v2'));
end;
$$;

create or replace function public.qnotes_requeue_embedding_failures(p_limit integer default 50)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  document_record record;
  queued_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'embedding requeue limit must be between 1 and 1000';
  end if;

  for document_record in
    select d.id
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
    where d.embedding_status = 'failed'
      and d.embedding_error in ('EMBEDDING_PROVIDER_TIMEOUT', 'EMBEDDING_FAILED')
      and d.embedding_model = 'gte-small'
      and d.embedding_model_version = 'v2'
    order by d.id
    limit p_limit
    for update of d skip locked
  loop
    update notesdb.search_documents
    set embedding_status = 'pending',
        embedding_attempts = 0,
        embedding_mode = 'provider',
        embedding_error = null,
        embedding_queued_at = timezone('utc', now())
    where id = document_record.id;
    queued_count := queued_count + 1;
  end loop;
  return queued_count;
end;
$$;

-- Keep the scheduled stale recovery bounded and unable to revive terminal
-- failures. Operators use qnotes_requeue_embedding_failures for explicit work.
create or replace function public.qnotes_requeue_stale_embeddings(
  p_stale_after interval default interval '15 minutes'
) returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  document_record record;
  queued_count integer := 0;
begin
  if p_stale_after is null or p_stale_after < interval '0 seconds' then
    return 0;
  end if;

  for document_record in
    select d.id, d.owner_id, d.content_hash
    from notesdb.search_documents d
    join notesdb.notes n on n.id = d.note_id and n.owner_id = d.owner_id and n.deleted_at is null
    where d.embedding_status in ('pending', 'failed')
      and d.embedding_attempts < 5
      and (d.embedding_queued_at is null or d.embedding_queued_at <= now() - p_stale_after)
      and d.embedding_input_hash is not null
      and d.embedding_model = 'gte-small'
      and d.embedding_model_version = 'v2'
    order by d.id
    limit 100
    for update of d skip locked
  loop
    perform public.qnotes_enqueue_embedding(document_record.id, document_record.owner_id, document_record.content_hash);
    queued_count := queued_count + 1;
  end loop;
  return queued_count;
end;
$$;

revoke all on function public.qnotes_requeue_embedding_failures(integer) from public, anon, authenticated;
grant execute on function public.qnotes_requeue_embedding_failures(integer) to service_role;
revoke all on function public.qnotes_requeue_stale_embeddings(interval) from public, anon, authenticated;
grant execute on function public.qnotes_requeue_stale_embeddings(interval) to service_role;

-- Keep terminal failures out of the scheduled queue timestamp and suppress a
-- duplicate enqueue when the worker claims an existing failed row.
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
  model_changed boolean := false;
  should_queue boolean := false;
begin
  expected_input_hash := public.qnotes_embedding_input_hash(new.source_title, new.heading_path, new.content);
  new.embedding_input_hash := expected_input_hash;

  if tg_op = 'UPDATE' then
    input_changed := old.embedding_input_hash is distinct from expected_input_hash;
    model_changed := old.embedding_model is distinct from 'gte-small'
      or old.embedding_model_version is distinct from 'v2';
  end if;

  if new.source_type = 'attachment_chunk' and new.page_number is null then
    page_match := regexp_match(new.source_key, ':page:([0-9]+):');
    if page_match is not null then new.page_number := page_match[1]::integer; end if;
  end if;

  if new.embedding_status = 'pending' then
    new.embedding := null;
    new.embedding_model := 'gte-small';
    new.embedding_model_version := 'v2';
    new.embedding_error := null;
    if tg_op = 'UPDATE'
      and old.embedding_status = 'failed'
      and not input_changed
      and not model_changed
      and coalesce(new.embedding_attempts, 0) >= 5
    then
      new.embedding_status := 'failed';
      new.embedding_error := old.embedding_error;
      new.embedding_queued_at := null;
    else
      new.embedding_queued_at := coalesce(new.embedding_queued_at, timezone('utc', now()));
      should_queue := tg_op = 'UPDATE' and (
        input_changed
        or model_changed
        or (old.embedding_status is distinct from 'pending'
          and old.embedding_status <> 'ready'
          and coalesce(new.embedding_attempts, 0) = 0)
      );
    end if;
  elsif new.embedding_status = 'failed' then
    new.embedding := null;
    new.embedding_model := 'gte-small';
    new.embedding_model_version := 'v2';
    if tg_op = 'UPDATE' and (input_changed or model_changed) then
      new.embedding_status := 'pending';
      new.embedding_error := null;
      should_queue := true;
    elsif coalesce(new.embedding_attempts, 0) >= 5 then
      new.embedding_queued_at := null;
    else
      new.embedding_queued_at := coalesce(new.embedding_queued_at, timezone('utc', now()));
    end if;
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
      should_queue := tg_op = 'UPDATE';
    else
      new.embedding_queued_at := null;
    end if;
  end if;

  -- A BEFORE trigger cannot safely call the guarded enqueue function because
  -- the table still contains the old row. Send the exact new invariants here.
  if should_queue then
    perform pgmq.send('note-embeddings', jsonb_build_object(
      'searchDocumentId', new.id,
      'ownerId', new.owner_id,
      'contentHash', new.content_hash,
      'embeddingInputHash', expected_input_hash,
      'embeddingModelVersion', 'v2'
    ));
  end if;
  return new;
end;
$$;
