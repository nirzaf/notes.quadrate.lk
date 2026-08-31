begin;
select plan(13);

select ok(to_regclass('notesdb.notebooks') is not null, 'notebooks table exists');
select is(
  (select array_agg(column_name order by ordinal_position)::text[] from information_schema.columns where table_schema = 'notesdb' and table_name = 'notebooks'),
  array['id','owner_id','name','created_at','updated_at']::text[],
  'notebooks has the required columns'
);
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'notebooks'), 'RLS is enabled on notebooks');
select ok(not has_table_privilege('anon', 'notesdb.notebooks', 'SELECT'), 'anon cannot select notebooks');
select ok(has_table_privilege('authenticated', 'notesdb.notebooks', 'SELECT'), 'authenticated can select notebooks');
select ok(not has_table_privilege('authenticated', 'notesdb.notebooks', 'INSERT'), 'authenticated cannot insert notebooks directly');

insert into notesdb.notebooks (id, owner_id, name)
select '77777777-7777-4777-8777-777777777777', id, 'Operations'
from auth.users where email = 'owner@qnotes.local';
select is((select count(*)::integer from notesdb.notebooks where id = '77777777-7777-4777-8777-777777777777'), 1, 'owner notebook can be created');

select is(
  (public.qnotes_create_note((select id from auth.users where email = 'owner@qnotes.local'), '66666666-6666-4666-8666-666666666666', 'notebook-note', 'Notebook Note', 'body', 'body', '{}', '66666666-6666-4666-8666-666666666667', '66666666-6666-4666-8666-666666666668', 'notebook-create-hash', '[]'::jsonb, '[]'::jsonb)->>'status'),
  'ok',
  'notebook fixture note is created'
);
select is(
  (public.qnotes_move_note_to_notebook((select id from auth.users where email = 'owner@qnotes.local'), '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', 1, '66666666-6666-4666-8666-666666666669', '66666666-6666-4666-8666-666666666670', 'notebook-move-hash')->>'status'),
  'ok',
  'note can be moved into an owned notebook'
);
select is((select notebook_id from notesdb.notes where id = '66666666-6666-4666-8666-666666666666')::text, '77777777-7777-4777-8777-777777777777', 'moving a note stores its notebook');
select is((public.qnotes_move_note_to_notebook((select id from auth.users where email = 'owner@qnotes.local'), '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', 1, '66666666-6666-4666-8666-666666666669', '66666666-6666-4666-8666-666666666670', 'notebook-move-hash')->>'status'), 'idempotent', 'moving the same mutation is idempotent');
select is((public.qnotes_move_note_to_notebook((select id from auth.users where email = 'owner@qnotes.local'), '66666666-6666-4666-8666-666666666666', '88888888-8888-4888-8888-888888888888', 2, '66666666-6666-4666-8666-666666666669', '66666666-6666-4666-8666-666666666671', 'notebook-invalid-hash')->>'status'), 'notebook_not_found', 'a note cannot be moved into another owner notebook');
select is((public.qnotes_move_note_to_notebook((select id from auth.users where email = 'owner@qnotes.local'), '66666666-6666-4666-8666-666666666666', null, 1, '66666666-6666-4666-8666-666666666669', '66666666-6666-4666-8666-666666666672', 'notebook-stale-hash')->>'status'), 'version_conflict', 'notebook moves use optimistic versions');

select * from finish();
rollback;
