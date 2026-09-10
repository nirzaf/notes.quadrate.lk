begin;
select plan(10);

select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', (select id::text from auth.users where email = 'owner@qnotes.local'))::text, true);
insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, last_mutation_id, updated_by_device_id)
select '11111111-1111-4111-8111-111111111111', id, 'rls-owner-a', 'Owner A', 'private A', 'private A', '{}', '11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111113' from auth.users where email = 'owner@qnotes.local';
insert into notesdb.notes (id, owner_id, slug, title, content_markdown, content_plain, tags, last_mutation_id, updated_by_device_id)
select '22222222-2222-4222-8222-222222222222', id, 'rls-owner-b', 'Owner B', 'private B', 'private B', '{}', '22222222-2222-4222-8222-222222222223', '22222222-2222-4222-8222-222222222224' from auth.users where email = 'other@qnotes.local';

set local role authenticated;
select is((select count(*)::integer from notesdb.notes), 1, 'Owner A can select only Owner A notes');
select is((select count(*)::integer from notesdb.notes where title = 'Owner B'), 0, 'Owner A cannot select Owner B notes');
select ok(not has_table_privilege('authenticated', 'notesdb.notes', 'UPDATE'), 'Owner A cannot update notes directly');
select ok((select bool_and(not has_table_privilege('authenticated', format('notesdb.%s', table_name), privilege_type)) from (values ('notes','INSERT'),('notes','DELETE'),('note_blocks','INSERT'),('note_blocks','DELETE'),('search_documents','INSERT'),('search_documents','DELETE'),('attachments','INSERT'),('attachments','DELETE')) as privileges(table_name, privilege_type)), 'authenticated cannot write application tables directly');
select ok(not has_table_privilege('authenticated', 'notesdb.note_mutations', 'SELECT'), 'note mutations are not directly readable');
select ok(not has_table_privilege('authenticated', 'notesdb.api_tokens', 'SELECT'), 'API tokens are not directly readable');
select ok(exists (select 1 from pg_policies where schemaname = 'notesdb' and tablename = 'notes' and cmd = 'SELECT' and qual like '%auth.uid()%'), 'notes use an auth.uid owner policy');
select ok(exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'realtime_user_notes_read' and cmd = 'SELECT' and qual like '%user:%' and qual like '%auth.uid%'), 'Realtime reads are scoped to the authenticated user topic');
select is((select count(*)::integer from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('note_attachments_select','note_attachments_insert','note_attachments_update','note_attachments_delete')), 4, 'Storage has all four private attachment policies');
select ok((select count(*) = 4 and bool_and(policyname = 'note_attachments_update' or ((coalesce(qual, '') like '%split_part(name%' or coalesce(with_check, '') like '%split_part(name%') and (coalesce(qual, '') like '%auth.uid%' or coalesce(with_check, '') like '%auth.uid%'))) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('note_attachments_select','note_attachments_insert','note_attachments_update','note_attachments_delete')), 'Storage policies constrain the first path segment or explicitly deny the operation');

select * from finish();
rollback;
