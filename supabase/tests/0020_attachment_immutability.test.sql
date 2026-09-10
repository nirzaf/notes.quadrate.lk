begin;
select plan(15);

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

update notesdb.attachments set extraction_status = 'processing' where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02';
select is((public.qnotes_complete_attachment_processing((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', (select object_generation from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), repeat('a', 64), '[]'::jsonb)->>'status'), 'ok', 'processing completes only with the same generation and digest');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'ready', 'completed attachment is ready');
select is((public.qnotes_request_attachment_deletion((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02')->>'status'), 'deleting', 'deletion enters a recoverable deleting state');
select is((select count(*)::integer from notesdb.search_documents where source_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 0, 'deleted attachment content is removed from search immediately');
select is((public.qnotes_complete_attachment_deletion((select id from auth.users where email = 'owner@qnotes.local'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02')->>'status'), 'ok', 'deletion completion is service-controlled');
select is((select extraction_status from notesdb.attachments where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02'), 'deleted', 'completed deletion is terminal');
select ok((select not has_function_privilege('authenticated', 'public.qnotes_complete_attachment_deletion(uuid,uuid)', 'EXECUTE') and has_function_privilege('service_role', 'public.qnotes_complete_attachment_deletion(uuid,uuid)', 'EXECUTE')), 'deletion completion is service-only');

select * from finish();
rollback;
