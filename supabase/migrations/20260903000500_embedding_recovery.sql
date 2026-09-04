-- Requeue stale embedding work without changing note contents or versions.

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
  -- Invalid recovery windows must never turn into an all-rows requeue.
  if p_stale_after is null or p_stale_after < interval '0 seconds' then
    return 0;
  end if;

  for document_record in
    select d.id, d.owner_id, d.content_hash
    from notesdb.search_documents d
    join notesdb.notes n
      on n.id = d.note_id
      and n.owner_id = d.owner_id
      and n.deleted_at is null
    where d.embedding_status in ('pending', 'failed')
      and (d.embedding_queued_at is null or d.embedding_queued_at <= now() - p_stale_after)
      -- These are the invariants checked by the guarded enqueue helper. Keep
      -- the candidate count aligned with rows that the helper can enqueue.
      and d.embedding_input_hash is not null
      and d.embedding_model = 'gte-small'
      and d.embedding_model_version = 'v2'
    order by d.id
    for update of d
  loop
    perform public.qnotes_enqueue_embedding(
      document_record.id,
      document_record.owner_id,
      document_record.content_hash
    );
    queued_count := queued_count + 1;
  end loop;

  return queued_count;
end;
$$;

revoke all on function public.qnotes_requeue_stale_embeddings(interval) from public, anon, authenticated;
grant execute on function public.qnotes_requeue_stale_embeddings(interval) to service_role;

-- The worker remains on its 30-second cadence; this is the daily recovery pass.
-- Reusing the fixed job name makes pg_cron scheduling idempotent.
select cron.schedule(
  'qnotes-requeue-stale-embeddings', '0 3 * * *',
  $$select public.qnotes_requeue_stale_embeddings();$$
);

-- Queue the currently stranded pending/failed documents for the existing worker.
select public.qnotes_requeue_stale_embeddings(interval '0 seconds');
