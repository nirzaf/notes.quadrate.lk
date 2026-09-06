begin;
select plan(11);

select ok(to_regclass('notesdb.oauth_authorization_code_uses') is not null, 'OAuth code use table exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'oauth_authorization_code_uses'), 'OAuth code use table has RLS enabled');
select ok(not has_table_privilege('anon', 'notesdb.oauth_authorization_code_uses', 'SELECT'), 'anon cannot read OAuth code uses');
select ok(not has_table_privilege('authenticated', 'notesdb.oauth_authorization_code_uses', 'SELECT'), 'authenticated cannot read OAuth code uses');
select ok(has_table_privilege('service_role', 'notesdb.oauth_authorization_code_uses', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role can manage OAuth code uses');
select ok(has_function_privilege('service_role', 'public.qnotes_consume_oauth_authorization_code(uuid,timestamptz)', 'EXECUTE'), 'service_role can consume OAuth codes');
select ok(not has_function_privilege('anon', 'public.qnotes_consume_oauth_authorization_code(uuid,timestamptz)', 'EXECUTE'), 'anon cannot consume OAuth codes');
select ok((select indexdef from pg_indexes where schemaname = 'notesdb' and indexname = 'oauth_authorization_code_uses_pkey') like '%code_id%', 'OAuth code IDs use a primary key for atomic replay protection');

select is(public.qnotes_consume_oauth_authorization_code('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timezone('utc', now()) + interval '90 seconds'), true, 'first OAuth code consume succeeds');
select is(public.qnotes_consume_oauth_authorization_code('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timezone('utc', now()) + interval '90 seconds'), false, 'second OAuth code consume fails');
select is(public.qnotes_consume_oauth_authorization_code('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', timezone('utc', now()) - interval '1 second'), false, 'expired OAuth code cannot be consumed');

select * from finish();
rollback;
