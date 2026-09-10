begin;
select plan(24);

select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', (select id::text from auth.users where email = 'owner@qnotes.local'))::text, true);

insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, last_mutation_id, updated_by_device_id)
select 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', id, 'attachment-lifecycle', 'Attachment lifecycle', '', '', '{}', gen_random_uuid(), gen_random_uuid()
from auth.users where email = 'owner@qnotes.local';

insert into notesdb.attachments (id, owner_id, note_id, object_path, staging_object_path, original_file_name, mime_type, size_bytes, storage_mode, staging_expires_at, extraction_status)
select 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
  id::text || '/eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01/final/eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02/file.txt',
  id::text || '/eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01/staging/eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02/file.txt',
  'file.txt', 'text/plain', 4, 'immutable', timezone('utc', now()) + interval '1 hour', 'pending_upload'
from auth.users where email = 'owner@qnotes.local';

select is((public.qnotes_begin_attachment_verification((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02')->>'status'), 'verifying', 'verification claims a pending immutable attachment');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'verifying', 'claimed attachment is marked verifying');
select ok((public.qnotes_begin_attachment_verification((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02')->>'claimed')::boolean = false, 'verification claim is single-use');
select is((public.qnotes_finalize_attachment((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', repeat('a', 64), (select object_generation from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'))->>'status'), 'ok', 'finalization records a verified digest');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'queued', 'verified attachment is queued exactly once');
select is((select checksum_sha256 from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), repeat('a', 64), 'verified digest is stored');
select ok((select verified_at is not null from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'verified attachment has a verification timestamp');
select is((public.qnotes_finalize_attachment((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', repeat('a', 64), gen_random_uuid())->>'status'), 'generation_conflict', 'finalization rejects a stale generation');
select is((public.qnotes_finalize_attachment((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', repeat('a', 64), null::uuid)->>'status'), 'generation_conflict', 'finalization rejects a null generation');

select throws_ok(
  $$insert into notesdb.attachments (id, owner_id, note_id, object_path, original_file_name, mime_type, size_bytes, storage_mode, extraction_status)
    values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03', (select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', 'legacy-test/immutable-null.txt', 'immutable-null.txt', 'text/plain', 1, 'immutable', 'queued')$$,
  '23514',
  null,
  'immutable queued attachments reject a null checksum'
);
insert into notesdb.attachments (id, owner_id, note_id, object_path, original_file_name, mime_type, size_bytes, storage_mode, extraction_status)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04', (select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', 'legacy-test/queued-no-checksum.txt', 'queued-no-checksum.txt', 'text/plain', 1, 'legacy', 'queued');
select ok((select storage_mode = 'legacy' and checksum_sha256 is null and extraction_status = 'queued' from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04'), 'legacy queued attachments may retain a null checksum');
update notesdb.attachments set extraction_status = 'processing' where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04';
select is((public.qnotes_complete_attachment_processing((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04', (select object_generation from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04'), repeat('b', 64), '[]'::jsonb)->>'status'), 'ok', 'legacy processing accepts a newly computed checksum when metadata is null');
select ok((select storage_mode = 'immutable' and checksum_sha256 = repeat('b', 64) and extraction_status = 'ready' from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04'), 'completed legacy attachment records its verified checksum');

insert into notesdb.attachments (id, owner_id, note_id, object_path, original_file_name, mime_type, size_bytes, storage_mode, extraction_status, updated_at)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05', (select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', 'legacy-test/stale-processing.txt', 'stale-processing.txt', 'text/plain', 1, 'legacy', 'processing', timezone('utc', now()) - interval '1 hour');
select is((public.qnotes_requeue_stale_attachment_processing(interval '15 minutes', 100)), 1, 'stale processing attachments are requeued');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05'), 'queued', 'stale processing attachment returns to queued');
select is((select count(*)::integer from pgmq.read('attachment-processing', 0, 100) where message->>'attachmentId' = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05'), 1, 'stale processing recovery sends one attachment job');

update notesdb.attachments set extraction_status = 'processing' where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02';
select is((public.qnotes_complete_attachment_processing((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', null::uuid, repeat('a', 64), '[]'::jsonb)->>'status'), 'integrity_conflict', 'processing rejects a null generation');
select is((public.qnotes_complete_attachment_processing((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', (select object_generation from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), repeat('a', 64), '[]'::jsonb)->>'status'), 'ok', 'processing completes only with the same generation and digest');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'ready', 'completed attachment is ready');
insert into notesdb.search_documents (owner_id, note_id, source_type, source_id, source_key, source_title, heading_path, content, content_hash, position, page_number, embedding_status)
values ((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', 'attachment_chunk', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', 'attachment:eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02:page:1:test', 'file.txt', 'Page 1', 'attachment content', 'attachment-content-hash', 0, 1, 'pending');
select is((public.qnotes_request_attachment_deletion((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02')->>'status'), 'deleting', 'deletion enters a recoverable deleting state');
select is((select count(*)::integer from notesdb.search_documents where source_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 0, 'deleted attachment content is removed from search immediately');
select is((public.qnotes_complete_attachment_deletion((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02')->>'status'), 'ok', 'deletion completion is service-controlled');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'deleted', 'completed deletion is terminal');
select ok((select not has_function_privilege('authenticated', 'public.qnotes_complete_attachment_deletion(uuid,uuid)', 'EXECUTE') and has_function_privilege('service_role', 'public.qnotes_complete_attachment_deletion(uuid,uuid)', 'EXECUTE')), 'deletion completion is service-only');

select * from finish();
rollback;
