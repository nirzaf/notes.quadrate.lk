begin;
select plan(38);

select ok(to_regclass('notesdb.note_shares') is not null, 'note shares table exists');
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'note_shares'),
  array['id','owner_id','note_id','token_prefix','token_hash','expires_at','revoked_at','created_at']::text[],
  'note shares has only the expected stored fields'
);
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'note_shares'), 'RLS is enabled on note shares');
select ok(not has_table_privilege('anon', 'notesdb.note_shares', 'SELECT'), 'anon cannot read note shares');
select ok(not has_table_privilege('authenticated', 'notesdb.note_shares', 'SELECT'), 'authenticated cannot read note shares');
select ok(has_table_privilege('service_role', 'notesdb.note_shares', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role can manage note shares');
select ok(exists (select 1 from pg_indexes where schemaname = 'notesdb' and indexname = 'note_shares_one_active_key' and indexdef like '%WHERE (revoked_at IS NULL)%'), 'only one active share is allowed per note');
select ok(exists (select 1 from pg_indexes where schemaname = 'notesdb' and indexname = 'note_shares_owner_note_created_key'), 'owner and note share lookup index exists');

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'public-share-note', 'Public Share Note', '# Private heading\n\nPrivate body', 'Private heading Private body', '{}',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'public-share-note-create', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'share fixture note is created');

select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Abcd1234', repeat('a', 64), null
)->>'status'), 'ok', 'an owner can create a share');
select is((select count(*)::integer from notesdb.note_shares where note_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null), 1, 'the note has one active share');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'notesdb' and table_name = 'note_shares' and column_name in ('token', 'raw_token')), 'the share table has no raw token column');
select is((select token_prefix from notesdb.note_shares where token_hash = repeat('a', 64)), 'qns_Abcd1234', 'only the short token prefix is stored');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('a', 64))), 1, 'a valid active share resolves');
select is((select title from public.qnotes_resolve_note_share(repeat('a', 64))), 'Public Share Note', 'resolver returns the note title');
select is((select content_markdown from public.qnotes_resolve_note_share(repeat('a', 64))), '# Private heading\n\nPrivate body', 'resolver returns the note markdown');
select ok((select updated_at from public.qnotes_resolve_note_share(repeat('a', 64))) is not null, 'resolver returns the note update time');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('c', 64))), 0, 'an unknown hash does not resolve');

select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Efgh5678', repeat('b', 64), timezone('utc', now()) + interval '1 hour'
)->>'status'), 'ok', 'rotating a share succeeds');
select ok((select revoked_at is not null from notesdb.note_shares where token_hash = repeat('a', 64)), 'rotation revokes the previous share');
select is((select count(*)::integer from notesdb.note_shares where note_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null), 1, 'rotation leaves exactly one active share');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('a', 64))), 0, 'the previous share no longer resolves');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('b', 64))), 1, 'the rotated share resolves');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'other@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Ijkl9012', repeat('c', 64), null
)->>'status'), 'not_found', 'another owner cannot create a share for the note');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Mnop3456', repeat('d', 64), timezone('utc', now()) - interval '1 minute'
)->>'status'), 'invalid_expiry', 'the database rejects expired shares');

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'public-share-delete', 'Delete Share Note', 'Delete body', 'Delete body', '{}',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd', 'public-share-delete-create', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'delete trigger fixture note is created');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'qns_Qrst7890', repeat('e', 64), null
)->>'status'), 'ok', 'delete trigger fixture share is created');
update notesdb.notes set deleted_at = timezone('utc', now()) where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select ok((select revoked_at is not null from notesdb.note_shares where token_hash = repeat('e', 64)), 'soft deleting a note revokes its share');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('e', 64))), 0, 'a deleted note cannot be resolved');
update notesdb.notes set deleted_at = null where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('e', 64))), 0, 'restoring a note does not reactivate its share');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'qns_Uvwx1234', repeat('f', 64), null
)->>'status'), 'ok', 'a restored note can receive a new share');
select is((public.qnotes_revoke_note_share((select id from auth.users where email = 'owner@qnotes.local'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->>'status'), 'ok', 'an owner can revoke a share');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('f', 64))), 0, 'a revoked share does not resolve');

select ok(not has_function_privilege('anon', 'public.qnotes_create_note_share(uuid,uuid,text,text,timestamptz)', 'EXECUTE'), 'anon cannot execute the create share RPC');
select ok(not has_function_privilege('authenticated', 'public.qnotes_resolve_note_share(text)', 'EXECUTE'), 'authenticated cannot execute the resolver RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_create_note_share(uuid,uuid,text,text,timestamptz)', 'EXECUTE'), 'service_role can execute the create share RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_resolve_note_share(text)', 'EXECUTE'), 'service_role can execute the resolver RPC');
select ok(exists (select 1 from pg_trigger where tgrelid = 'notesdb.notes'::regclass and tgname = 'notes_revoke_share_on_delete'), 'note deletion trigger is installed');

select * from finish();
rollback;
