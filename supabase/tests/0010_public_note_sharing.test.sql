begin;
select plan(52);

select ok(to_regclass('notesdb.note_shares') is not null, 'note shares table exists');
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'note_shares'),
  array['id','owner_id','note_id','token_prefix','token_hash','expires_at','revoked_at','created_at','source_version','source_updated_at','source_content_hash','snapshot_title','snapshot_content_markdown','classification']::text[],
  'note shares stores immutable snapshot metadata'
);
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'note_shares'), 'RLS is enabled on note shares');
select ok(not has_table_privilege('anon', 'notesdb.note_shares', 'SELECT'), 'anon cannot read note shares');
select ok(not has_table_privilege('authenticated', 'notesdb.note_shares', 'SELECT'), 'authenticated cannot read note shares');
select ok(has_table_privilege('service_role', 'notesdb.note_shares', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role can manage note shares');
select ok(exists (select 1 from pg_indexes where schemaname = 'notesdb' and indexname = 'note_shares_one_active_key' and indexdef like '%snapshot_content_markdown%'), 'only one active snapshot share is allowed per note');
select ok(exists (select 1 from pg_indexes where schemaname = 'notesdb' and indexname = 'note_shares_owner_note_created_key'), 'owner and note share lookup index exists');

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'public-share-note', 'Public Share Note', '# Private heading\n\nPrivate body', 'Private heading Private body', '{}',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'public-share-note-create', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'share fixture note is created');

select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Abcd1234', repeat('a', 64), timezone('utc', now()) + interval '1 hour',
  1, 'Public Share Note', '# Private heading\n\nPrivate body',
  encode(digest(convert_to('Public Share Note' || E'\n' || '# Private heading\n\nPrivate body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'ok', 'an owner can create a reviewed snapshot');
select is((select count(*)::integer from notesdb.note_shares where note_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null and snapshot_content_markdown is not null), 1, 'the note has one active snapshot share');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'notesdb' and table_name = 'note_shares' and column_name in ('token', 'raw_token')), 'the share table has no raw token column');
select is((select token_prefix from notesdb.note_shares where token_hash = repeat('a', 64)), 'qns_Abcd1234', 'only the short token prefix is stored');
select is((select source_version from notesdb.note_shares where token_hash = repeat('a', 64)), 1::bigint, 'the snapshot binds the source version');
select is((select snapshot_title from notesdb.note_shares where token_hash = repeat('a', 64)), 'Public Share Note', 'the reviewed title is stored');
select is((select snapshot_content_markdown from notesdb.note_shares where token_hash = repeat('a', 64)), '# Private heading\n\nPrivate body', 'the reviewed Markdown is stored');
select ok((select source_updated_at is not null from notesdb.note_shares where token_hash = repeat('a', 64)), 'the snapshot stores the source update time');
select ok((select source_content_hash ~ '^[a-f0-9]{64}$' from notesdb.note_shares where token_hash = repeat('a', 64)), 'the snapshot stores a content hash');
select is((select classification from notesdb.note_shares where token_hash = repeat('a', 64)), 'publishable', 'the snapshot stores its publication classification');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('a', 64))), 1, 'a valid active snapshot resolves');
select is((select title from public.qnotes_resolve_note_share(repeat('a', 64))), 'Public Share Note', 'resolver returns the snapshot title');
select is((select content_markdown from public.qnotes_resolve_note_share(repeat('a', 64))), '# Private heading\n\nPrivate body', 'resolver returns the snapshot Markdown');
select ok((select updated_at from public.qnotes_resolve_note_share(repeat('a', 64))) is not null, 'resolver returns the snapshot update time');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('c', 64))), 0, 'an unknown hash does not resolve');

update notesdb.notes
set title = 'Public Share Note v2',
    content_markdown = 'Updated private body',
    content_plain = 'Updated private body',
    version = 2,
    updated_at = timezone('utc', now())
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select is((select version::integer from notesdb.notes where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 2, 'a private edit advances the source version');
select is((select title from public.qnotes_resolve_note_share(repeat('a', 64))), 'Public Share Note', 'a later private edit does not change the snapshot title');
select is((select content_markdown from public.qnotes_resolve_note_share(repeat('a', 64))), '# Private heading\n\nPrivate body', 'a later private edit does not change the snapshot Markdown');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Stal1234', repeat('b', 64), timezone('utc', now()) + interval '1 hour',
  1, 'Public Share Note', '# Private heading\n\nPrivate body',
  encode(digest(convert_to('Public Share Note' || E'\n' || '# Private heading\n\nPrivate body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'version_conflict', 'a stale review cannot publish a later note version');
select is((select count(*)::integer from notesdb.note_shares where note_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revoked_at is null and snapshot_content_markdown is not null), 1, 'a stale publication does not create a new active snapshot');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Efgh5678', repeat('b', 64), timezone('utc', now()) + interval '1 hour',
  2, 'Public Share Note v2', 'Updated private body',
  encode(digest(convert_to('Public Share Note v2' || E'\n' || 'Updated private body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'ok', 'republishing explicitly reviewed content succeeds');
select ok((select revoked_at is not null from notesdb.note_shares where token_hash = repeat('a', 64)), 'republishing revokes the previous snapshot');
select is((select title from public.qnotes_resolve_note_share(repeat('b', 64))), 'Public Share Note v2', 'the republished snapshot resolves its reviewed title');
select is((select content_markdown from public.qnotes_resolve_note_share(repeat('b', 64))), 'Updated private body', 'the republished snapshot resolves its reviewed Markdown');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Cnfrm123', repeat('c', 64), timezone('utc', now()) + interval '1 hour',
  2, 'Public Share Note v2', 'Updated private body',
  encode(digest(convert_to('Public Share Note v2' || E'\n' || 'Updated private body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', false
)->>'status'), 'not_confirmed', 'publication requires explicit confirmation');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Sens1234', repeat('d', 64), timezone('utc', now()) + interval '1 hour',
  2, 'Sensitive', 'password=synthetic-secret',
  encode(digest(convert_to('Sensitive' || E'\n' || 'password=synthetic-secret', 'UTF8'), 'sha256'), 'hex'),
  'sensitive', true
)->>'status'), 'sensitive', 'sensitive classification is rejected by the publish RPC');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Hash1234', repeat('e', 64), timezone('utc', now()) + interval '1 hour',
  2, 'Public Share Note v2', 'Updated private body', repeat('f', 64), 'publishable', true
)->>'status'), 'invalid_snapshot', 'a mismatched content hash is rejected');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Expire12', repeat('g', 64), null,
  2, 'Public Share Note v2', 'Updated private body',
  encode(digest(convert_to('Public Share Note v2' || E'\n' || 'Updated private body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'invalid_expiry', 'new snapshots require a finite expiry');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'other@qnotes.local'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Ijkl9012', repeat('h', 64), timezone('utc', now()) + interval '1 hour',
  2, 'Public Share Note v2', 'Updated private body',
  encode(digest(convert_to('Public Share Note v2' || E'\n' || 'Updated private body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'not_found', 'another owner cannot create a snapshot for the note');

insert into notesdb.note_shares (owner_id, note_id, token_prefix, token_hash, expires_at)
values ((select id from auth.users where email = 'owner@qnotes.local'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'qns_Legacy99', repeat('1', 64), null);
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('1', 64))), 0, 'legacy live-share rows do not remain publicly resolvable');

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'public-share-delete', 'Delete Share Note', 'Delete body', 'Delete body', '{}',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd', 'public-share-delete-create', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'delete trigger fixture note is created');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'qns_Qrst7890', repeat('2', 64), timezone('utc', now()) + interval '1 hour',
  1, 'Delete Share Note', 'Delete body',
  encode(digest(convert_to('Delete Share Note' || E'\n' || 'Delete body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'ok', 'delete trigger fixture snapshot is created');
update notesdb.notes set deleted_at = timezone('utc', now()) where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select ok((select revoked_at is not null from notesdb.note_shares where token_hash = repeat('2', 64)), 'soft deleting a note revokes its snapshot');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('2', 64))), 0, 'a deleted note cannot be resolved');
update notesdb.notes set deleted_at = null where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('2', 64))), 0, 'restoring a deleted note does not reactivate its snapshot');
select is((public.qnotes_create_note_share(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'qns_Uvwx1234', repeat('3', 64), timezone('utc', now()) + interval '1 hour',
  1, 'Delete Share Note', 'Delete body',
  encode(digest(convert_to('Delete Share Note' || E'\n' || 'Delete body', 'UTF8'), 'sha256'), 'hex'),
  'publishable', true
)->>'status'), 'ok', 'a restored note can receive a new reviewed snapshot');
select is((public.qnotes_revoke_note_share((select id from auth.users where email = 'owner@qnotes.local'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->>'status'), 'ok', 'an owner can revoke snapshots');
select is((select count(*)::integer from public.qnotes_resolve_note_share(repeat('3', 64))), 0, 'a revoked snapshot does not resolve');

select ok(not has_function_privilege('anon', 'public.qnotes_create_note_share(uuid,uuid,text,text,timestamptz,bigint,text,text,text,text,boolean)', 'EXECUTE'), 'anon cannot execute the create snapshot RPC');
select ok(not has_function_privilege('authenticated', 'public.qnotes_resolve_note_share(text)', 'EXECUTE'), 'authenticated cannot execute the resolver RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_create_note_share(uuid,uuid,text,text,timestamptz,bigint,text,text,text,text,boolean)', 'EXECUTE'), 'service_role can execute the create snapshot RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_resolve_note_share(text)', 'EXECUTE'), 'service_role can execute the resolver RPC');
select ok(exists (select 1 from pg_trigger where tgrelid = 'notesdb.notes'::regclass and tgname = 'notes_revoke_share_on_delete'), 'note deletion trigger is installed');

select * from finish();
rollback;
