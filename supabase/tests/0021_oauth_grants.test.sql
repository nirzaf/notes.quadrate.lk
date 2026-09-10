begin;
select plan(39);

select has_table('notesdb', 'oauth_grants', 'OAuth grant bindings exist');
select has_column('notesdb', 'oauth_grants', 'owner_id', 'grants bind an owner');
select has_column('notesdb', 'oauth_grants', 'source_token_id', 'grants bind the source personal token');
select has_column('notesdb', 'oauth_grants', 'scopes', 'grants store effective action scopes');
select has_column('notesdb', 'oauth_grants', 'notebook_ids', 'grants store effective notebook scopes');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'oauth_grants'), 'OAuth grants have RLS enabled');
select ok(not has_table_privilege('authenticated', 'notesdb.oauth_grants', 'SELECT'), 'authenticated cannot read OAuth grants directly');
select ok(has_table_privilege('service_role', 'notesdb.oauth_grants', 'SELECT,INSERT,UPDATE,DELETE'), 'service role can manage OAuth grants');
select ok(has_function_privilege('service_role', 'public.qnotes_create_oauth_grant(text,text,text,text[],timestamptz,text,boolean,uuid[])', 'EXECUTE'), 'service role can create OAuth grants');
select ok(not has_function_privilege('anon', 'public.qnotes_create_oauth_grant(text,text,text,text[],timestamptz,text,boolean,uuid[])', 'EXECUTE'), 'anon cannot create OAuth grants');
select ok(has_function_privilege('service_role', 'public.qnotes_oauth_grant_context(uuid,text,text)', 'EXECUTE'), 'service role can resolve OAuth grants');
select ok(not has_function_privilege('anon', 'public.qnotes_oauth_grant_context(uuid,text,text)', 'EXECUTE'), 'anon cannot resolve OAuth grants');
select ok(has_function_privilege('service_role', 'public.qnotes_revoke_oauth_grant(uuid,text,text)', 'EXECUTE'), 'service role can revoke OAuth grants');
select ok(has_function_privilege('service_role', 'public.qnotes_purge_expired_oauth_grants(integer)', 'EXECUTE'), 'service role can purge OAuth grants');
select ok(not has_function_privilege('anon', 'public.qnotes_purge_expired_oauth_grants(integer)', 'EXECUTE'), 'anon cannot purge OAuth grants');
select ok(exists(select 1 from cron.job where jobname = 'qnotes-purge-oauth-grants'), 'OAuth grant cleanup is scheduled');

insert into notesdb.notebooks (id, owner_id, name) values
  ('a2000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'US20 A'),
  ('a2000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'US20 B');

select public.qnotes_create_api_token(
  (select id from auth.users where email = 'owner@qnotes.local'), 'US20 broad source', 'qnt_us20_broad', repeat('a', 64),
  ARRAY['notes:read', 'notes:write', 'search:read']::text[], null, 'account', true, '{}'::uuid[]
);
select public.qnotes_create_api_token(
  (select id from auth.users where email = 'owner@qnotes.local'), 'US20 notebook source', 'qnt_us20_notebook', repeat('b', 64),
  ARRAY['notes:read', 'search:read']::text[], null, 'notebooks', false, ARRAY['a2000000-0000-4000-8000-000000000001']::uuid[]
);

create temporary table us20_broad_grant on commit drop as
select public.qnotes_create_oauth_grant(
  repeat('a', 64), 'client-us20', 'https://qnotes.test/mcp',
  ARRAY['notes:read', 'search:read']::text[], timezone('utc', now()) + interval '15 minutes',
  null, null, null
) as response;
select is((select response->>'access_mode' from us20_broad_grant), 'account', 'broad source token keeps account access policy');
select is((select response->'scopes' from us20_broad_grant), '["notes:read", "search:read"]'::jsonb, 'OAuth grant stores the explicitly mapped narrower action scopes');
select is((select count(*)::integer from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_broad_grant), 'client-us20', 'https://qnotes.test/mcp')), 1, 'active OAuth grant resolves');
select is((select owner_id from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_broad_grant), 'client-us20', 'https://qnotes.test/mcp')), (select id from auth.users where email = 'owner@qnotes.local'), 'grant resolution returns only its owner');
select is((select scopes from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_broad_grant), 'client-us20', 'https://qnotes.test/mcp')), ARRAY['notes:read', 'search:read']::text[], 'grant resolution returns only consented actions');
select ok((select last_used_at is not null from notesdb.api_tokens where token_hash = repeat('a', 64)), 'successful OAuth resolution updates source token activity');

create temporary table us20_notebook_grant on commit drop as
select public.qnotes_create_oauth_grant(
  repeat('b', 64), 'client-us20', 'https://qnotes.test/mcp',
  ARRAY['notes:read', 'search:read']::text[], timezone('utc', now()) + interval '15 minutes',
  null, null, null
) as response;
select is((select response->>'access_mode' from us20_notebook_grant), 'notebooks', 'notebook-scoped source policy stays notebook-scoped');
select is((select notebook_ids from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_notebook_grant), 'client-us20', 'https://qnotes.test/mcp')), ARRAY['a2000000-0000-4000-8000-000000000001']::uuid[], 'grant resolution preserves only the source notebook');
select is((select allow_unfiled from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_notebook_grant), 'client-us20', 'https://qnotes.test/mcp')), false, 'grant resolution preserves the source unfiled restriction');

select throws_ok($$select public.qnotes_create_oauth_grant(repeat('b', 64), 'client-us20', 'https://qnotes.test/mcp', ARRAY['notes:read']::text[], timezone('utc', now()) + interval '15 minutes', 'account', true, '{}'::uuid[])$$, 'P0001', 'oauth_access_not_granted', 'a notebook-scoped source cannot be widened to account access');
select throws_ok($$select public.qnotes_create_oauth_grant(repeat('b', 64), 'client-us20', 'https://qnotes.test/mcp', ARRAY['notes:write']::text[], timezone('utc', now()) + interval '15 minutes', null, null, null)$$, 'P0001', 'oauth_scope_not_granted', 'a grant cannot add an action absent from the source token');
select public.qnotes_create_api_token(
  (select id from auth.users where email = 'owner@qnotes.local'), 'US20 notes-only source', 'qnt_us20_notes_only', repeat('c', 64),
  ARRAY['notes:read']::text[], null, 'account', true, '{}'::uuid[]
);
select throws_ok($$select public.qnotes_create_oauth_grant(repeat('c', 64), 'client-us20', 'https://qnotes.test/mcp', ARRAY['notes:read', 'search:read']::text[], timezone('utc', now()) + interval '15 minutes', null, null, null)$$, 'P0001', 'oauth_scope_not_granted', 'the hosted read profile fails closed when the source token lacks search access');

create temporary table us20_narrow_grant on commit drop as
select public.qnotes_create_oauth_grant(
  repeat('a', 64), 'client-us20', 'https://qnotes.test/mcp',
  ARRAY['notes:read', 'search:read']::text[], timezone('utc', now()) + interval '15 minutes',
  'notebooks', false, ARRAY['a2000000-0000-4000-8000-000000000001']::uuid[]
) as response;
select is((select response->>'access_mode' from us20_narrow_grant), 'notebooks', 'an account token can receive an explicitly narrower notebook grant');
select is((select notebook_ids from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_narrow_grant), 'client-us20', 'https://qnotes.test/mcp')), ARRAY['a2000000-0000-4000-8000-000000000001']::uuid[], 'narrow grant exposes only the consented notebook');
select is((select count(*)::integer from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_narrow_grant), 'other-client', 'https://qnotes.test/mcp')), 0, 'wrong OAuth client cannot resolve a grant');
select is((select count(*)::integer from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_narrow_grant), 'client-us20', 'https://other.test/mcp')), 0, 'wrong OAuth resource cannot resolve a grant');
select is(public.qnotes_revoke_oauth_grant((select (response->>'id')::uuid from us20_narrow_grant), 'client-us20', 'https://qnotes.test/mcp'), true, 'the bound client can revoke its grant');
select is((select count(*)::integer from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_narrow_grant), 'client-us20', 'https://qnotes.test/mcp')), 0, 'revoked grants cannot be resolved');
select is(public.qnotes_revoke_oauth_grant((select (response->>'id')::uuid from us20_narrow_grant), 'client-us20', 'https://qnotes.test/mcp'), false, 'revoking an already revoked grant is idempotently false');

select throws_ok($$select public.qnotes_create_oauth_grant(repeat('a', 64), 'client-us20', 'https://qnotes.test/mcp', ARRAY['notes:read']::text[], timezone('utc', now()) - interval '1 second', null, null, null)$$, 'P0001', 'oauth_expiry_invalid', 'expired grants are not issued');
update notesdb.api_tokens set revoked_at = timezone('utc', now()) where token_hash = repeat('a', 64);
select is((select count(*)::integer from public.qnotes_oauth_grant_context((select (response->>'id')::uuid from us20_broad_grant), 'client-us20', 'https://qnotes.test/mcp')), 0, 'revoking the source personal token invalidates issued OAuth access');

insert into notesdb.oauth_grants (
  owner_id, source_token_id, client_id, resource, scopes, access_mode,
  allow_unfiled, expires_at, revoked_at
) values
  (
    (select id from auth.users where email = 'owner@qnotes.local'),
    (select id from notesdb.api_tokens where token_hash = repeat('a', 64)),
    'cleanup-expired', 'https://qnotes.test/mcp', ARRAY['notes:read'], 'account', true,
    timezone('utc', now()) - interval '1 hour', null
  ),
  (
    (select id from auth.users where email = 'owner@qnotes.local'),
    (select id from notesdb.api_tokens where token_hash = repeat('a', 64)),
    'cleanup-revoked', 'https://qnotes.test/mcp', ARRAY['notes:read'], 'account', true,
    timezone('utc', now()) + interval '1 hour', timezone('utc', now()) - interval '2 days'
  );
select is(public.qnotes_purge_expired_oauth_grants(10), 2, 'bounded cleanup removes expired and retained revoked grants');
select is((select count(*)::integer from notesdb.oauth_grants where client_id in ('cleanup-expired', 'cleanup-revoked')), 0, 'cleaned OAuth grants are deleted');

select * from finish();
rollback;
