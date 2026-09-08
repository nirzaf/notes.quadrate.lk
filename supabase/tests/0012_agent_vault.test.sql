begin;
select plan(73);

select ok(to_regclass('notesdb.vault_projects') is not null, 'Vault projects table exists');
select ok(to_regclass('notesdb.vault_environments') is not null, 'Vault environments table exists');
select ok(to_regclass('notesdb.vault_secrets') is not null, 'Vault secrets metadata table exists');
select ok(to_regclass('notesdb.vault_agent_tokens') is not null, 'Vault agent token table exists');
select ok(to_regclass('notesdb.vault_agent_grants') is not null, 'Vault grants table exists');
select ok(to_regclass('notesdb.vault_audit_events') is not null, 'Vault audit table exists');
select ok(to_regclass('notesdb.vault_mutations') is not null, 'Vault mutation receipts table exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'vault_secrets'), 'Vault metadata uses RLS');
select ok(not has_table_privilege('anon', 'notesdb.vault_secrets', 'SELECT'), 'anon cannot read Vault metadata directly');
select ok(not has_table_privilege('authenticated', 'notesdb.vault_secrets', 'SELECT'), 'authenticated cannot read Vault metadata directly');
select ok(not has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT'), 'anon cannot read decrypted Vault values directly');
select ok(not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT'), 'authenticated cannot read decrypted Vault values directly');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)'::regprocedure), 'Vault reveal RPC is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'anon cannot execute the reveal RPC');
select ok(not has_function_privilege('authenticated', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'authenticated cannot execute the reveal RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'service_role can execute the reveal RPC');

insert into notesdb.vault_projects (id, owner_id, slug, name)
values
  ('a1000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'vault-rpc-owner-a', 'Synthetic owner A project'),
  ('b1000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'other@qnotes.local'), 'vault-rpc-owner-b', 'Synthetic owner B project');

insert into notesdb.vault_environments (id, owner_id, project_id, slug, name)
values
  ('a1000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'a1000000-0000-4000-8000-000000000001', 'synthetic-a', 'Synthetic owner A environment'),
  ('b1000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'other@qnotes.local'), 'b1000000-0000-4000-8000-000000000001', 'synthetic-b', 'Synthetic owner B environment');

create temporary table vault_rpc_test_values on commit drop as
select encode(gen_random_bytes(24), 'hex') as primary_value,
       encode(gen_random_bytes(24), 'hex') as rotated_value,
       encode(gen_random_bytes(24), 'hex') as reveal_value,
       encode(gen_random_bytes(24), 'hex') as owner_b_value,
       repeat('d', 64) as token_hash;

create temporary table vault_rpc_create_a on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'ROTATION_TARGET',
  'synthetic metadata',
  (select primary_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000011',
  repeat('a', 64),
  null,
  'a1000000-0000-4000-8000-000000000012',
  'user_jwt'
) as response;

select is((select response->>'status' from vault_rpc_create_a), 'ok', 'create returns ok');
select is((select (response->'secret'->>'version')::bigint from vault_rpc_create_a), 1::bigint, 'created secret starts at version 1');
select ok((select count(*) = 1 from notesdb.vault_audit_events where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and action = 'secret:write' and secret_id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid and success and result_code = 'created' and request_id = 'a1000000-0000-4000-8000-000000000012'), 'create writes a success audit event');
select ok((select count(*) = 1 from notesdb.vault_mutations where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and mutation_id = 'a1000000-0000-4000-8000-000000000011' and operation = 'created' and request_hash = repeat('a', 64)), 'create writes one mutation receipt');

select is((public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'ROTATION_TARGET',
  'synthetic metadata',
  (select primary_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000011',
  repeat('a', 64),
  null,
  'a1000000-0000-4000-8000-000000000012',
  'user_jwt'
)->>'status'), 'idempotent', 'an identical create replay returns its receipt');
select is((select count(*)::integer from notesdb.vault_secrets where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and environment_id = 'a1000000-0000-4000-8000-000000000002' and name = 'ROTATION_TARGET' and deleted_at is null), 1, 'a create replay does not duplicate the metadata row');
select is((select count(*)::integer from notesdb.vault_mutations where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and mutation_id = 'a1000000-0000-4000-8000-000000000011'), 1, 'a create replay does not add a receipt');

select is((public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'ROTATION_TARGET',
  'synthetic metadata',
  (select rotated_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000011',
  repeat('b', 64),
  null,
  'a1000000-0000-4000-8000-000000000013',
  'user_jwt'
)->>'status'), 'mutation_reuse_conflict', 'a create mutation cannot be reused with a different request hash');
select ok((select exists (select 1 from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid and version = 1)), 'a create mutation conflict leaves the original secret unchanged');
select is((public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'ROTATION_TARGET',
  'synthetic metadata',
  (select rotated_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000014',
  repeat('c', 64),
  null,
  'a1000000-0000-4000-8000-000000000015',
  'user_jwt'
)->>'status'), 'secret_conflict', 'a different create mutation cannot reuse an active secret name');
select ok((select not exists (select 1 from notesdb.vault_mutations where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and mutation_id = 'a1000000-0000-4000-8000-000000000014'), 'a rejected create does not write a mutation receipt');

create temporary table vault_rpc_rotate_a on commit drop as
select public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  (select rotated_value from vault_rpc_test_values),
  'synthetic rotated metadata',
  1,
  'a1000000-0000-4000-8000-000000000021',
  repeat('e', 64),
  null,
  'a1000000-0000-4000-8000-000000000022',
  'user_jwt'
) as response;

select is((select response->>'status' from vault_rpc_rotate_a), 'ok', 'rotate returns ok at the expected version');
select is((select (response->'secret'->>'version')::bigint from vault_rpc_rotate_a), 2::bigint, 'a successful rotate increments the version once');
select ok((select count(*) = 1 from notesdb.vault_audit_events where action = 'secret:write' and secret_id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid and success and result_code = 'rotated' and request_id = 'a1000000-0000-4000-8000-000000000022'), 'rotate writes a success audit event');
select ok((select count(*) = 1 from notesdb.vault_mutations where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and mutation_id = 'a1000000-0000-4000-8000-000000000021' and operation = 'rotated'), 'rotate writes one mutation receipt');

select is((public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  (select rotated_value from vault_rpc_test_values),
  'synthetic rotated metadata',
  1,
  'a1000000-0000-4000-8000-000000000021',
  repeat('e', 64),
  null,
  'a1000000-0000-4000-8000-000000000023',
  'user_jwt'
)->>'status'), 'idempotent', 'an identical rotate replay returns its receipt');
select is((select version from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid), 2::bigint, 'a rotate replay does not increment the version');
select is((public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  (select primary_value from vault_rpc_test_values),
  'synthetic rotated metadata',
  1,
  'a1000000-0000-4000-8000-000000000021',
  repeat('f', 64),
  null,
  'a1000000-0000-4000-8000-000000000024',
  'user_jwt'
)->>'status'), 'mutation_reuse_conflict', 'a rotate mutation cannot be reused with a different request hash');
select is((public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  (select primary_value from vault_rpc_test_values),
  'synthetic stale metadata',
  1,
  'a1000000-0000-4000-8000-000000000025',
  repeat('1', 64),
  null,
  'a1000000-0000-4000-8000-000000000026',
  'user_jwt'
)->>'status'), 'version_conflict', 'a new stale rotate returns a version conflict');
select is((public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  (select primary_value from vault_rpc_test_values),
  'synthetic stale metadata',
  1,
  'a1000000-0000-4000-8000-000000000027',
  repeat('2', 64),
  null,
  'a1000000-0000-4000-8000-000000000028',
  'user_jwt'
)->>'currentVersion'), '2', 'a rotate version conflicts return the authoritative version');
select is((select version from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid), 2::bigint, 'a stale rotate leaves the current version unchanged');

select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  1,
  'a1000000-0000-4000-8000-000000000031',
  repeat('3', 64),
  null,
  'a1000000-0000-4000-8000-000000000032',
  'user_jwt'
)->>'status'), 'version_conflict', 'a stale delete returns a version conflict');
select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  1,
  'a1000000-0000-4000-8000-000000000033',
  repeat('4', 64),
  null,
  'a1000000-0000-4000-8000-000000000034',
  'user_jwt'
)->>'currentVersion'), '2', 'a delete version conflicts return the authoritative version');
select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  2,
  'a1000000-0000-4000-8000-000000000035',
  repeat('5', 64),
  null,
  'a1000000-0000-4000-8000-000000000036',
  'user_jwt'
)->>'status'), 'ok', 'delete returns ok at the expected version');
select ok((select version = 3 and deleted_at is not null from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid), 'delete increments the version and marks the metadata deleted');
select ok((select count(*) = 1 from notesdb.vault_audit_events where action = 'secret:delete' and secret_id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid and success and result_code = 'deleted' and request_id = 'a1000000-0000-4000-8000-000000000036'), 'delete writes a success audit event');
select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  2,
  'a1000000-0000-4000-8000-000000000035',
  repeat('5', 64),
  null,
  'a1000000-0000-4000-8000-000000000037',
  'user_jwt'
)->>'status'), 'idempotent', 'an identical delete replay returns its receipt');
select is((select version from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid), 3::bigint, 'a delete replay does not change the version');
select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  2,
  'a1000000-0000-4000-8000-000000000035',
  repeat('6', 64),
  null,
  'a1000000-0000-4000-8000-000000000038',
  'user_jwt'
)->>'status'), 'mutation_reuse_conflict', 'a delete mutation cannot be reused with a different request hash');
select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_a))::uuid,
  3,
  'a1000000-0000-4000-8000-000000000039',
  repeat('7', 64),
  null,
  'a1000000-0000-4000-8000-000000000040',
  'user_jwt'
)->>'status'), 'not_found', 'a new delete cannot delete an already deleted secret');

create temporary table vault_rpc_create_reveal on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'AUDIT_TARGET',
  'synthetic reveal metadata',
  (select reveal_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000041',
  repeat('8', 64),
  null,
  'a1000000-0000-4000-8000-000000000042',
  'user_jwt'
) as response;
select is((select response->>'status' from vault_rpc_create_reveal), 'ok', 'reveal fixture create returns ok');

create temporary table vault_rpc_reveal_success on commit drop as
select public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid,
  null,
  'synthetic reveal audit ordering',
  'a1000000-0000-4000-8000-000000000043',
  'user_jwt'
) as response;
select is((select response->>'status' from vault_rpc_reveal_success), 'ok', 'reveal returns ok for an active secret');
select ok((select jsonb_typeof(response->'secret'->'value') = 'string' and octet_length(response->'secret'->>'value') > 0 from vault_rpc_reveal_success), 'reveal returns a non-empty synthetic value');
select ok((select count(*) = 1 from notesdb.vault_audit_events where owner_id = (select id from auth.users where email = 'owner@qnotes.local') and actor_kind = 'user_jwt' and actor_token_id is null and action = 'secret:reveal' and secret_id = ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid and purpose = 'synthetic reveal audit ordering' and success and result_code = 'revealed' and request_id = 'a1000000-0000-4000-8000-000000000043'), 'reveal success is audited before the RPC returns');

create function pg_temp.fail_vault_rpc_audit_insert() returns trigger
language plpgsql
as $$
begin
  raise exception 'synthetic Vault audit failure';
end;
$$;

create trigger vault_rpc_test_fail_audit
before insert on notesdb.vault_audit_events
for each row execute function pg_temp.fail_vault_rpc_audit_insert();

create function pg_temp.vault_rpc_reveal_returns() returns boolean
language plpgsql
as $$
begin
  perform public.qnotes_vault_reveal_secret(
    (select id from auth.users where email = 'owner@qnotes.local'),
    ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid,
    null,
    'synthetic forced audit failure',
    'a1000000-0000-4000-8000-000000000044',
    'user_jwt'
  );
  return true;
exception when others then
  return false;
end;
$$;
select ok(not pg_temp.vault_rpc_reveal_returns(), 'a reveal audit failure prevents a successful return');
select ok((select not exists (select 1 from notesdb.vault_audit_events where request_id = 'a1000000-0000-4000-8000-000000000044'), 'a failed reveal audit insert rolls back the reveal transaction'));

drop trigger vault_rpc_test_fail_audit on notesdb.vault_audit_events;
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid,
  null,
  'synthetic post-failure reveal',
  'a1000000-0000-4000-8000-000000000045',
  'user_jwt'
)->>'status'), 'ok', 'the reveal fixture remains available after an audit rollback');
select ok((select count(*) = 1 from notesdb.vault_audit_events where request_id = 'a1000000-0000-4000-8000-000000000045' and success and result_code = 'revealed'), 'a later successful reveal writes its audit event');

create temporary table vault_rpc_token on commit drop as
select public.qnotes_create_vault_agent_token(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'synthetic grant token',
  'qvt_Test0001',
  (select token_hash from vault_rpc_test_values),
  null,
  jsonb_build_array(
    jsonb_build_object('projectId', 'a1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', null, 'secretId', null, 'action', 'metadata:read'),
    jsonb_build_object('projectId', 'a1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a1000000-0000-4000-8000-000000000002'::uuid, 'secretId', null, 'action', 'secret:write'),
    jsonb_build_object('projectId', 'a1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a1000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid, 'action', 'secret:reveal')
  )
) as response;

select ok((select response->>'id' is not null and jsonb_array_length(response->'grants') = 3 from vault_rpc_token), 'token creation returns all three grant scopes');
select is((select count(*)::integer from notesdb.vault_agent_grants where token_id = ((select response->>'id' from vault_rpc_token))::uuid), 3, 'token creation stores all grant rows');
select ok((select exists (select 1 from notesdb.vault_agent_grants where token_id = ((select response->>'id' from vault_rpc_token))::uuid and project_id = 'a1000000-0000-4000-8000-000000000001' and environment_id is null and secret_id is null and action = 'metadata:read')), 'project grant scope is stored without a narrower resource');
select ok((select exists (select 1 from notesdb.vault_agent_grants where token_id = ((select response->>'id' from vault_rpc_token))::uuid and project_id = 'a1000000-0000-4000-8000-000000000001' and environment_id = 'a1000000-0000-4000-8000-000000000002' and secret_id is null and action = 'secret:write')), 'environment grant scope is stored without a secret restriction');
select ok((select exists (select 1 from notesdb.vault_agent_grants where token_id = ((select response->>'id' from vault_rpc_token))::uuid and project_id = 'a1000000-0000-4000-8000-000000000001' and environment_id = 'a1000000-0000-4000-8000-000000000002' and secret_id = ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid and action = 'secret:reveal')), 'secret grant scope is stored with its exact secret restriction');

create temporary table vault_rpc_replace_grants on commit drop as
select public.qnotes_replace_vault_agent_grants(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->>'id' from vault_rpc_token))::uuid,
  jsonb_build_array(
    jsonb_build_object('projectId', 'a1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a1000000-0000-4000-8000-000000000002'::uuid, 'secretId', null, 'action', 'metadata:read'),
    jsonb_build_object('projectId', 'a1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a1000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid, 'action', 'secret:reveal')
  )
) as response;
select is((select response->>'status' from vault_rpc_replace_grants), 'ok', 'grant replacement returns ok');
select is((select jsonb_array_length(response->'grants')::integer from vault_rpc_replace_grants), 2, 'grant replacement returns the requested scope variants');
select is((select count(*)::integer from notesdb.vault_agent_grants where token_id = ((select response->>'id' from vault_rpc_token))::uuid), 2, 'grant replacement replaces the prior grant set');
select is((public.qnotes_replace_vault_agent_grants(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->>'id' from vault_rpc_token))::uuid,
  '[]'::jsonb
)->>'status'), 'ok', 'grant replacement can clear every grant');
select is((select count(*)::integer from notesdb.vault_agent_grants where token_id = ((select response->>'id' from vault_rpc_token))::uuid), 0, 'clearing grants leaves no effective grant rows');
select is((public.qnotes_replace_vault_agent_grants(
  (select id from auth.users where email = 'other@qnotes.local'),
  ((select response->>'id' from vault_rpc_token))::uuid,
  '[]'::jsonb
)->>'status'), 'not_found', 'another owner cannot replace the token grant set');

create temporary table vault_rpc_create_b on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'other@qnotes.local'),
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'OWNER_B_SECRET',
  'synthetic owner B metadata',
  (select owner_b_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000011',
  repeat('a', 64),
  null,
  'b1000000-0000-4000-8000-000000000012',
  'user_jwt'
) as response;
select is((select response->>'status' from vault_rpc_create_b), 'ok', 'the other owner can use the same mutation identity independently');
select is((select count(*)::integer from notesdb.vault_mutations where mutation_id = 'a1000000-0000-4000-8000-000000000011'), 2, 'mutation receipts are isolated by owner');
select is((public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'OWNER_A_CANNOT_CREATE_HERE',
  'synthetic cross-owner metadata',
  (select primary_value from vault_rpc_test_values),
  'a1000000-0000-4000-8000-000000000051',
  repeat('9', 64),
  null,
  'a1000000-0000-4000-8000-000000000052',
  'user_jwt'
)->>'status'), 'project_not_found', 'an owner cannot create a secret in another owner project');
select is((public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_b))::uuid,
  (select rotated_value from vault_rpc_test_values),
  'synthetic cross-owner metadata',
  1,
  'a1000000-0000-4000-8000-000000000053',
  repeat('a', 64),
  null,
  'a1000000-0000-4000-8000-000000000054',
  'user_jwt'
)->>'status'), 'not_found', 'an owner cannot rotate another owner secret');
select is((public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_b))::uuid,
  1,
  'a1000000-0000-4000-8000-000000000055',
  repeat('b', 64),
  null,
  'a1000000-0000-4000-8000-000000000056',
  'user_jwt'
)->>'status'), 'not_found', 'an owner cannot delete another owner secret');
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_b))::uuid,
  null,
  'synthetic cross-owner reveal',
  'a1000000-0000-4000-8000-000000000057',
  'user_jwt'
)->>'status'), 'not_found', 'an owner cannot reveal another owner secret');
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'other@qnotes.local'),
  ((select response->'secret'->>'id' from vault_rpc_create_reveal))::uuid,
  null,
  'synthetic cross-owner reveal',
  'b1000000-0000-4000-8000-000000000058',
  'user_jwt'
)->>'status'), 'not_found', 'the other owner cannot reveal the owner A secret');
select is((public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'other@qnotes.local'),
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'OWNER_B_CANNOT_CREATE_HERE',
  'synthetic cross-owner metadata',
  (select owner_b_value from vault_rpc_test_values),
  'b1000000-0000-4000-8000-000000000059',
  repeat('c', 64),
  null,
  'b1000000-0000-4000-8000-000000000060',
  'user_jwt'
)->>'status'), 'project_not_found', 'the other owner cannot create a secret in owner A project');

select * from finish();
rollback;
