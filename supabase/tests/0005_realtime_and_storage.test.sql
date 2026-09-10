begin;
select plan(10);

select ok(exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'notes' and t.tgname = 'notes_realtime_after_change' and not t.tgisinternal), 'notes have the realtime change trigger');
select ok(exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'realtime_user_notes_read' and cmd = 'SELECT' and qual like '%extension%' and qual like '%broadcast%' and qual like '%realtime.topic()%'), 'Realtime policy only reads private broadcast user topics');
select is((select count(*)::integer from pg_policies where schemaname = 'realtime' and tablename = 'messages' and cmd = 'INSERT'), 0, 'clients cannot publish note-change broadcasts');
select ok((select not public from storage.buckets where id = 'note-attachments'), 'note attachments bucket is private');
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'note_attachments_select' and qual like '%bucket_id%' and qual like '%auth.uid%'), 'attachment reads require the owner path');
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'note_attachments_insert' and with_check like '%split_part(name%' and with_check like '%staging%'), 'attachment uploads require a registered staging path');
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'note_attachments_update' and qual like '%false%' and with_check like '%false%'), 'attachment overwrites are denied');
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'note_attachments_delete' and qual like '%staging%'), 'attachment deletes are limited to staging paths');
select ok((select count(*) = 4 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'note_attachments_%'), 'all attachment operations have scoped policies');
select ok((select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and has_function_privilege('service_role', p.oid, 'EXECUTE')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('qnotes_create_note','qnotes_update_note','qnotes_soft_delete_note','qnotes_restore_note','qnotes_begin_attachment_verification','qnotes_finalize_attachment','qnotes_complete_attachment_processing','qnotes_requeue_stale_attachment_processing','qnotes_request_attachment_deletion','qnotes_complete_attachment_deletion','qnotes_fail_attachment_processing')), 'service-only RPCs are not publicly executable');

select * from finish();
rollback;
