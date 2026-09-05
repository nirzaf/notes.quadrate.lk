begin;
select plan(16);

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '99999999-9999-4999-8999-999999999901', 'append-retry-note', 'Append Retry Note', 'Existing', 'Existing', '{}',
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999903', 'append-create-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'append fixture is created');

select is((public.qnotes_append_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '99999999-9999-4999-8999-999999999901', 'Existing\n\nAdded\n', 'Existing Added', 1,
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999904', 'append-logical-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'the first append commits');
select is((select version from notesdb.notes where id = '99999999-9999-4999-8999-999999999901'), 2::bigint, 'the first append increments once');
select is((select content_markdown from notesdb.notes where id = '99999999-9999-4999-8999-999999999901'), 'Existing\n\nAdded\n', 'the appended content is stored once');

-- This represents a response lost after commit. The candidate body is what a
-- retrying API request would derive after re-reading the now-advanced note;
-- the receipt identity must win before version checking or body replacement.
select is((public.qnotes_append_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '99999999-9999-4999-8999-999999999901', 'Existing\n\nAdded\n\nAdded\n', 'Existing Added Added', 2,
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999904', 'append-logical-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'idempotent', 'a committed append replay returns its receipt');
select is((select version from notesdb.notes where id = '99999999-9999-4999-8999-999999999901'), 2::bigint, 'a replay does not increment the note');
select is((select content_markdown from notesdb.notes where id = '99999999-9999-4999-8999-999999999901'), 'Existing\n\nAdded\n', 'a replay does not duplicate or roll back content');

select is((public.qnotes_append_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '99999999-9999-4999-8999-999999999901', 'Existing\n\nAdded\n\nAdded\n', 'Existing Added Added', 2,
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999905', 'append-second-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'an identical intentional append with a new identity commits');
select is((select content_markdown from notesdb.notes where id = '99999999-9999-4999-8999-999999999901'), 'Existing\n\nAdded\n\nAdded\n', 'different logical appends both remain');
select is((public.qnotes_append_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '99999999-9999-4999-8999-999999999901', 'Existing\n\nAdded\n\nChanged\n', 'Existing Added Changed', 3,
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999905', 'append-reused-different-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'mutation_reuse_conflict', 'reusing an append identity with different arguments is rejected');
select is((public.qnotes_append_note(
  (select id from auth.users where email = 'owner@qnotes.local'),
  '99999999-9999-4999-8999-999999999901', 'Existing\n\nAdded\n\nStale\n', 'Existing Added Stale', 2,
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999906', 'append-stale-new-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'version_conflict', 'a genuinely new stale append remains a conflict');

select is((public.qnotes_create_note(
  (select id from auth.users where email = 'other@qnotes.local'),
  '99999999-9999-4999-8999-999999999907', 'other-append-note', 'Other Append Note', 'Other', 'Other', '{}',
  '99999999-9999-4999-8999-999999999908', '99999999-9999-4999-8999-999999999909', 'other-create-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'the second owner has an append fixture');
select is((public.qnotes_append_note(
  (select id from auth.users where email = 'other@qnotes.local'),
  '99999999-9999-4999-8999-999999999907', 'Other\n\nShared identity\n', 'Other Shared identity', 1,
  '99999999-9999-4999-8999-999999999902', '99999999-9999-4999-8999-999999999904', 'append-logical-hash', '[]'::jsonb, '[]'::jsonb
)->>'status'), 'ok', 'receipt identities are isolated by owner');
select is((select content_markdown from notesdb.notes where id = '99999999-9999-4999-8999-999999999907'), 'Other\n\nShared identity\n', 'the second owner receives its own append');
select ok((select has_function_privilege('anon', 'public.qnotes_append_note(uuid,uuid,text,text,bigint,uuid,uuid,text,jsonb,jsonb)', 'EXECUTE') is false), 'append RPC is not publicly executable');
select ok((select has_function_privilege('service_role', 'public.qnotes_append_note(uuid,uuid,text,text,bigint,uuid,uuid,text,jsonb,jsonb)', 'EXECUTE')), 'append RPC is executable by service_role');

select * from finish();
rollback;
