begin;
select plan(15);

select ok(
  (select p.prokind = 'f'
      and p.prorettype = 'int4'::regtype
      and p.proargnames = array['p_stale_after']::text[]
      and p.proargdefaults is not null
      and p.prosecdef
   from pg_proc p
   where p.oid = 'public.qnotes_requeue_stale_embeddings(interval)'::regprocedure),
  'stale embedding recovery function has the interval signature, default, integer result, and SECURITY DEFINER'
);

select is(
  (select schedule from cron.job where jobname = 'qnotes-requeue-stale-embeddings'),
  '0 3 * * *',
  'stale embedding recovery runs daily at 03:00 UTC'
);
select ok(
  (select position('qnotes_requeue_stale_embeddings' in command) > 0
   from cron.job
   where jobname = 'qnotes-requeue-stale-embeddings'),
  'stale embedding cron job calls the recovery function'
);
select is(
  (select schedule from cron.job where jobname = 'qnotes-process-embeddings'),
  '30 seconds',
  'existing embedding worker cron remains on its 30-second schedule'
);

select ok(
  (select not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
   from pg_proc p
   where p.oid = 'public.qnotes_requeue_stale_embeddings(interval)'::regprocedure),
  'stale embedding recovery is executable only by service_role among API roles'
);

insert into notesdb.notes (
  id, owner_id, slug, title, content_markdown, content_plain, tags,
  version, last_mutation_id, updated_by_device_id, deleted_at
)
values
  (
    '88888888-8888-4888-8888-888888888801',
    (select id from auth.users where email = 'owner@qnotes.local'),
    'recovery-active', 'Recovery Active', 'active body', 'active body', '{}',
    7, '88888888-8888-4888-8888-888888888811', '88888888-8888-4888-8888-888888888812', null
  ),
  (
    '88888888-8888-4888-8888-888888888802',
    (select id from auth.users where email = 'owner@qnotes.local'),
    'recovery-deleted', 'Recovery Deleted', 'deleted body', 'deleted body', '{}',
    8, '88888888-8888-4888-8888-888888888813', '88888888-8888-4888-8888-888888888814', '2026-01-01T00:00:00Z'
  ),
  (
    '88888888-8888-4888-8888-888888888803',
    (select id from auth.users where email = 'other@qnotes.local'),
    'recovery-other-owner', 'Recovery Other Owner', 'other body', 'other body', '{}',
    9, '88888888-8888-4888-8888-888888888815', '88888888-8888-4888-8888-888888888816', null
  );

-- The trigger normally supplies a queue timestamp. Disable it only for this
-- fixed fixture so the null-queued_at branch is exercised directly.
alter table notesdb.search_documents disable trigger search_documents_prepare_embedding;
insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, heading_path,
  content, content_hash, position, embedding_status, embedding_model,
  embedding_model_version, embedding_input_hash, embedding_queued_at
)
values (
  '88888888-8888-4888-8888-888888888821',
  (select id from auth.users where email = 'owner@qnotes.local'),
  '88888888-8888-4888-8888-888888888801', 'note_chunk', 'recovery-null-queued',
  'Recovery Active', null, 'recovery pending body', 'recovery-current-content-hash', 0,
  'pending', 'gte-small', 'v2',
  public.qnotes_embedding_input_hash('Recovery Active', null, 'recovery pending body'), null
);
alter table notesdb.search_documents enable trigger search_documents_prepare_embedding;

insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, heading_path,
  content, content_hash, position, embedding_status, embedding_model,
  embedding_model_version, embedding_input_hash, embedding_queued_at
)
values
  (
    '88888888-8888-4888-8888-888888888822',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '88888888-8888-4888-8888-888888888801', 'note_chunk', 'recovery-failed-stale',
    'Recovery Active', null, 'recovery failed body', 'recovery-failed-content-hash', 1,
    'failed', 'gte-small', 'v2',
    public.qnotes_embedding_input_hash('Recovery Active', null, 'recovery failed body'),
    '2026-01-01T00:00:00Z'
  ),
  (
    '88888888-8888-4888-8888-888888888823',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '88888888-8888-4888-8888-888888888801', 'note_chunk', 'recovery-fresh',
    'Recovery Active', null, 'recovery fresh body', 'recovery-fresh-content-hash', 2,
    'pending', 'gte-small', 'v2',
    public.qnotes_embedding_input_hash('Recovery Active', null, 'recovery fresh body'), now()
  ),
  (
    '88888888-8888-4888-8888-888888888825',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '88888888-8888-4888-8888-888888888802', 'note_chunk', 'recovery-deleted-doc',
    'Recovery Deleted', null, 'recovery deleted body', 'recovery-deleted-content-hash', 0,
    'pending', 'gte-small', 'v2',
    public.qnotes_embedding_input_hash('Recovery Deleted', null, 'recovery deleted body'),
    '2026-01-01T00:00:00Z'
  ),
  (
    '88888888-8888-4888-8888-888888888826',
    (select id from auth.users where email = 'owner@qnotes.local'),
    '88888888-8888-4888-8888-888888888803', 'note_chunk', 'recovery-owner-mismatch',
    'Recovery Other Owner', null, 'recovery mismatched body', 'recovery-mismatch-content-hash', 0,
    'pending', 'gte-small', 'v2',
    public.qnotes_embedding_input_hash('Recovery Other Owner', null, 'recovery mismatched body'),
    '2026-01-01T00:00:00Z'
  );

insert into notesdb.search_documents (
  id, owner_id, note_id, source_type, source_key, source_title, heading_path,
  content, content_hash, position, embedding, embedding_status, embedding_model,
  embedding_model_version, embedding_input_hash, embedding_queued_at
)
values (
  '88888888-8888-4888-8888-888888888824',
  (select id from auth.users where email = 'owner@qnotes.local'),
  '88888888-8888-4888-8888-888888888801', 'note_chunk', 'recovery-ready',
  'Recovery Active', null, 'recovery ready body', 'recovery-ready-content-hash', 3,
  ('[' || repeat('0,', 383) || '0]')::extensions.vector,
  'ready', 'gte-small', 'v2',
  public.qnotes_embedding_input_hash('Recovery Active', null, 'recovery ready body'),
  '2026-01-01T00:00:00Z'
);

select is(
  public.qnotes_requeue_stale_embeddings(interval '-1 second'),
  0,
  'negative stale intervals safely do nothing'
);
select is(
  public.qnotes_requeue_stale_embeddings(null::interval),
  0,
  'null stale intervals safely do nothing'
);

select is(
  public.qnotes_requeue_stale_embeddings(interval '15 minutes'),
  2,
  'return count includes only active stale pending and failed documents'
);

select is(
  (select count(*)::integer
   from pgmq.read('note-embeddings', 0, 10000) q
   where q.message->>'searchDocumentId' = '88888888-8888-4888-8888-888888888821'
     and q.message->>'contentHash' = 'recovery-current-content-hash'
     and q.message->>'embeddingInputHash' = public.qnotes_embedding_input_hash('Recovery Active', null, 'recovery pending body')
     and q.message->>'embeddingModelVersion' = 'v2'),
  1,
  'eligible fixture is queued with the current content and input hashes'
);
select is(
  (select count(*)::integer
   from pgmq.read('note-embeddings', 0, 10000) q
   where q.message->>'searchDocumentId' = '88888888-8888-4888-8888-888888888822'
     and q.message->>'contentHash' = 'recovery-failed-content-hash'),
  1,
  'failed stale fixture is queued through the guarded helper'
);
select is(
  (select count(*)::integer
   from pgmq.read('note-embeddings', 0, 10000) q
   where q.message->>'searchDocumentId' in (
     '88888888-8888-4888-8888-888888888823',
     '88888888-8888-4888-8888-888888888824',
     '88888888-8888-4888-8888-888888888825',
     '88888888-8888-4888-8888-888888888826'
   )),
  0,
  'fresh, ready, deleted-note, and owner-mismatched documents are not queued'
);

select ok(
  (select embedding_queued_at is not null
   from notesdb.search_documents
   where id = '88888888-8888-4888-8888-888888888821'),
  'null queue timestamps are populated when work is requeued'
);
select ok(
  (select embedding_queued_at = now()
   from notesdb.search_documents
   where id = '88888888-8888-4888-8888-888888888823'),
  'fresh queue timestamps are left unchanged'
);
select is(
  (select version from notesdb.notes where id = '88888888-8888-4888-8888-888888888801'),
  7::bigint,
  'recovery does not modify note versions'
);
select is(
  (select content_markdown from notesdb.notes where id = '88888888-8888-4888-8888-888888888801'),
  'active body',
  'recovery does not modify note contents'
);

select * from finish();
rollback;
