begin;
select plan(21);

select ok(to_regprocedure('public.qnotes_vault_resolve_resource(uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid)') is not null, 'the exact Vault resource resolver exists');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_vault_resolve_resource(uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid)'::regprocedure), 'the exact Vault resource resolver is SECURITY DEFINER');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_resolve_resource(uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid)', 'EXECUTE'), 'service_role can execute the exact Vault resource resolver');
select ok(not has_function_privilege('anon', 'public.qnotes_vault_resolve_resource(uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid)', 'EXECUTE'), 'anon cannot execute the exact Vault resource resolver');
select ok(not has_function_privilege('authenticated', 'public.qnotes_vault_resolve_resource(uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid)', 'EXECUTE'), 'authenticated cannot execute the exact Vault resource resolver directly');
select ok(coalesce(array_to_string((select p.proconfig from pg_proc p where p.oid = 'public.qnotes_vault_resolve_resource(uuid,uuid,text,text,uuid,text,uuid,text,uuid,text,uuid)'::regprocedure), ','), '') like '%lock_timeout=5s%', 'the exact Vault resource resolver has a bounded lock wait');

insert into notesdb.vault_projects (id, owner_id, slug, name)
values ('f1600000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'exact-project', 'Exact resource project');

insert into notesdb.vault_environments (id, owner_id, project_id, slug, name)
values
  ('f1600000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'f1600000-0000-4000-8000-000000000001', 'stable', 'Duplicate display name'),
  ('f1600000-0000-4000-8000-000000000003', (select id from auth.users where email = 'owner@qnotes.local'), 'f1600000-0000-4000-8000-000000000001', 'stable-two', 'Duplicate display name'),
  ('f1600000-0000-4000-8000-000000000004', (select id from auth.users where email = 'owner@qnotes.local'), 'f1600000-0000-4000-8000-000000000001', 'f2600000-0000-4000-8000-000000000001', 'UUID-shaped slug');

insert into notesdb.vault_secrets (id, owner_id, project_id, environment_id, name, vault_secret_id)
select
  ('f1600000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
  (select id from auth.users where email = 'owner@qnotes.local'),
  'f1600000-0000-4000-8000-000000000001',
  'f1600000-0000-4000-8000-000000000002',
  case when number = 1001 then 'TARGET_AFTER_PAGE' else 'FORBIDDEN_' || lpad(number::text, 4, '0') end,
  gen_random_uuid()
from generate_series(1, 1001) as source(number);

select is((select count(*)::integer from notesdb.vault_secrets where environment_id = 'f1600000-0000-4000-8000-000000000002'), 1001, 'the fixture contains a target beyond the first 1000 metadata rows');
select is((select count(*)::integer from notesdb.vault_environments where project_id = 'f1600000-0000-4000-8000-000000000001' and name = 'Duplicate display name'), 2, 'display names can collide while resource slugs remain distinct');

insert into notesdb.vault_agent_tokens (id, owner_id, name, token_prefix, token_hash, expires_at)
values ('f1600000-0000-4000-8000-000000000011', (select id from auth.users where email = 'owner@qnotes.local'), 'US16 exact token', 'qvt_US16A001', repeat('f', 64), clock_timestamp() + interval '1 hour');

insert into notesdb.vault_agent_grants (owner_id, token_id, project_id, environment_id, secret_id, action)
values (
  (select id from auth.users where email = 'owner@qnotes.local'),
  'f1600000-0000-4000-8000-000000000011',
  'f1600000-0000-4000-8000-000000000001',
  'f1600000-0000-4000-8000-000000000002',
  'f1600000-0000-4000-8000-000000001001',
  'metadata:read'
);

create temporary table us16_exact_selector on commit drop as
select public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'f1600000-0000-4000-8000-000000000011',
  'vault_agent',
  'metadata:read',
  null,
  'EXACT-PROJECT',
  null,
  'STABLE',
  null,
  'target_after_page',
  'f1600000-0000-4000-8000-000000000012'
) as response;
select is((select response->>'status' from us16_exact_selector), 'ok', 'a secret-only grant resolves its exact selector without project enumeration');
select is((select response->'resource' from us16_exact_selector), jsonb_build_object('projectId', 'f1600000-0000-4000-8000-000000000001', 'environmentId', 'f1600000-0000-4000-8000-000000000002', 'secretId', 'f1600000-0000-4000-8000-000000001001'), 'the exact selector returns only the three immutable resource IDs');

create temporary table us16_exact_id on commit drop as
select public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'f1600000-0000-4000-8000-000000000011',
  'vault_agent',
  'metadata:read',
  null,
  null,
  null,
  null,
  'f1600000-0000-4000-8000-000000001001',
  null,
  'f1600000-0000-4000-8000-000000000013'
) as response;
select is((select response->>'status' from us16_exact_id), 'ok', 'the same secret-only grant resolves its immutable secret ID directly');
select is((select response->'resource'->>'secretId' from us16_exact_id), 'f1600000-0000-4000-8000-000000001001', 'direct ID resolution reaches the target after the backend page boundary');

create temporary table us16_denied_selector on commit drop as
select public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'f1600000-0000-4000-8000-000000000011',
  'vault_agent',
  'metadata:read',
  null,
  'exact-project',
  null,
  'stable',
  null,
  'forbidden_0001',
  'f1600000-0000-4000-8000-000000000014'
) as response;
select is((select response->>'status' from us16_denied_selector), 'access_denied', 'an unauthorized sibling selector is denied');
select ok(not ((select response from us16_denied_selector) ? 'resource'), 'an unauthorized sibling selector returns no resource metadata');

create temporary table us16_denied_id on commit drop as
select public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'f1600000-0000-4000-8000-000000000011',
  'vault_agent',
  'metadata:read',
  null,
  null,
  null,
  null,
  'f1600000-0000-4000-8000-000000000001',
  null,
  'f1600000-0000-4000-8000-000000000015'
) as response;
select is((select response->>'status' from us16_denied_id), 'access_denied', 'an unauthorized sibling ID is denied');
select ok(not ((select response from us16_denied_id) ? 'resource'), 'an unauthorized sibling ID returns no resource metadata');

select is((public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'), null, 'user_jwt', 'metadata:read',
  null, 'exact-project', null, 'stable-two', null, null,
  'f1600000-0000-4000-8000-000000000016'
)->'resource'->>'environmentId'), 'f1600000-0000-4000-8000-000000000003', 'the environment slug selects the intended resource when display names collide');

select is((public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'), null, 'user_jwt', 'metadata:read',
  null, 'exact-project', null, 'f2600000-0000-4000-8000-000000000001', null, null,
  'f1600000-0000-4000-8000-000000000017'
)->'resource'->>'environmentId'), 'f1600000-0000-4000-8000-000000000004', 'a UUID-shaped slug is resolved through its explicit slug parameter');

select is((public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'), null, 'user_jwt', 'secret:write',
  null, 'exact-project', null, 'stable', null, null,
  'f1600000-0000-4000-8000-000000000018'
)->'resource'->>'secretId'), null, 'environment resolution for creation returns no secret ID');
select is((public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'), null, 'user_jwt', 'secret:reveal',
  null, 'exact-project', null, 'stable', null, null,
  'f1600000-0000-4000-8000-000000000019'
)->>'status'), 'invalid_reference', 'secret actions require an exact secret reference');
select is((public.qnotes_vault_resolve_resource(
  (select id from auth.users where email = 'owner@qnotes.local'), null, 'user_jwt', 'metadata:read',
  null, 'exact-project', 'f1600000-0000-4000-8000-000000000002', 'stable', null, null,
  'f1600000-0000-4000-8000-000000000020'
)->>'status'), 'invalid_reference', 'a selector cannot provide both an environment ID and slug');

select * from finish();
rollback;
