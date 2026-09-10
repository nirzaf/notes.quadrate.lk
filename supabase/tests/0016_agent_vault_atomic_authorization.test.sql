begin;
select plan(26);

select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_vault_create_secret(uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid,text)'::regprocedure), 'create wrapper is SECURITY DEFINER');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)'::regprocedure), 'reveal wrapper is SECURITY DEFINER');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'service_role can execute the hardened reveal wrapper');
select ok(not has_function_privilege('service_role', 'public.qnotes_vault_reveal_secret_legacy(uuid,uuid,uuid,text,uuid,text)', 'EXECUTE'), 'service_role cannot bypass the hardened reveal wrapper');
select ok(coalesce(array_to_string((select p.proconfig from pg_proc p where p.oid = 'public.qnotes_vault_reveal_secret(uuid,uuid,uuid,text,uuid,text)'::regprocedure), ','), '') like '%lock_timeout=5s%', 'reveal wrapper has a bounded lock wait');
select ok(coalesce(array_to_string((select p.proconfig from pg_proc p where p.oid = 'public.qnotes_replace_vault_agent_grants(uuid,uuid,jsonb)'::regprocedure), ','), '') like '%lock_timeout=5s%', 'grant replacement has a bounded lock wait');
select ok(has_function_privilege('service_role', 'public.qnotes_revoke_vault_agent_token(uuid,uuid)', 'EXECUTE'), 'service_role can execute the locked token revocation RPC');
select ok(not has_function_privilege('service_role', 'public.qnotes_vault_authorize_actor(uuid,uuid,text,text,uuid,uuid,uuid,uuid)', 'EXECUTE'), 'authorization helper is not a public broker entry point');

insert into notesdb.vault_projects (id, owner_id, slug, name)
values
  ('c1000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'atomic-owner-a', 'Atomic owner A'),
  ('d1000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'other@qnotes.local'), 'atomic-owner-b', 'Atomic owner B');

insert into notesdb.vault_environments (id, owner_id, project_id, slug, name)
values
  ('c1000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'c1000000-0000-4000-8000-000000000001', 'atomic-a', 'Atomic environment A'),
  ('d1000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'other@qnotes.local'), 'd1000000-0000-4000-8000-000000000001', 'atomic-b', 'Atomic environment B');

create temporary table atomic_secret_a on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'c1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000002',
  'ATOMIC_SECRET_A',
  'synthetic atomic value',
  'synthetic-atomic-secret-a',
  'c1000000-0000-4000-8000-000000000011',
  repeat('a', 64),
  null,
  'c1000000-0000-4000-8000-000000000012',
  'user_jwt'
) as response;
select is((select response->>'status' from atomic_secret_a), 'ok', 'the atomic authorization fixture secret is created');

create temporary table atomic_token_a on commit drop as
select public.qnotes_create_vault_agent_token(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'atomic token A',
  'qvt_AtomicA1',
  repeat('c', 64),
  clock_timestamp() + interval '1 hour',
  jsonb_build_array(
    jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'c1000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from atomic_secret_a))::uuid, 'action', 'secret:reveal'),
    jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'c1000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from atomic_secret_a))::uuid, 'action', 'secret:write')
  )
) as response;
select ok((select response->>'id' is not null from atomic_token_a), 'the agent token fixture is created');

select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from atomic_secret_a))::uuid,
  ((select response->>'id' from atomic_token_a))::uuid,
  'forged actor kind',
  'c1000000-0000-4000-8000-000000000013',
  'user_jwt'
)->>'status'), 'access_denied', 'a token-bearing call cannot relabel itself as a user JWT');
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'other@qnotes.local'),
  ((select response->'secret'->>'id' from atomic_secret_a))::uuid,
  ((select response->>'id' from atomic_token_a))::uuid,
  'forged owner',
  'c1000000-0000-4000-8000-000000000014',
  'vault_agent'
)->>'status'), 'access_denied', 'a fabricated owner cannot inherit another token privileges');
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from atomic_secret_a))::uuid,
  ((select response->>'id' from atomic_token_a))::uuid,
  'authorized synthetic reveal',
  'c1000000-0000-4000-8000-000000000015',
  'vault_agent'
)->>'status'), 'ok', 'an authorized token can reveal its exact granted secret');
select ok((select count(*) = 1 from notesdb.vault_audit_events where request_id = 'c1000000-0000-4000-8000-000000000015' and actor_kind = 'vault_agent' and success and result_code = 'revealed'), 'successful reveal audit commits before the response');

create temporary table atomic_duplicate_batch on commit drop as
select public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(
    jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001', 'environmentId', 'c1000000-0000-4000-8000-000000000002', 'secretId', ((select response->'secret'->>'id' from atomic_secret_a))),
    jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001', 'environmentId', 'c1000000-0000-4000-8000-000000000002', 'secretId', ((select response->'secret'->>'id' from atomic_secret_a)))
  ),
  ((select response->>'id' from atomic_token_a))::uuid,
  'deduplicated synthetic batch',
  'c1000000-0000-4000-8000-000000000016',
  'vault_agent'
) as response;
select is((select response->>'status' from atomic_duplicate_batch), 'ok', 'a duplicate selector batch is authorized once');
select is((select jsonb_array_length(response->'items')::integer from atomic_duplicate_batch), 1, 'duplicate selectors cannot duplicate plaintext results');

create temporary table atomic_cleared_grants on commit drop as
select public.qnotes_replace_vault_agent_grants(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->>'id' from atomic_token_a))::uuid,
  '[]'::jsonb
) as response;
select is((select response->>'status' from atomic_cleared_grants), 'ok', 'grant replacement clears the token under its row lock');
create temporary table atomic_denied_rotate on commit drop as
select public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from atomic_secret_a))::uuid,
  'should-not-rotate',
  null,
  1,
  'c1000000-0000-4000-8000-000000000017',
  repeat('d', 64),
  null,
  ((select response->>'id' from atomic_token_a))::uuid,
  'c1000000-0000-4000-8000-000000000018',
  'vault_agent'
) as response;
select is((select response->>'status' from atomic_denied_rotate), 'access_denied', 'grant shrinkage denies a later mutation inside the RPC');
select is((select version from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from atomic_secret_a))::uuid), 1::bigint, 'a denied mutation does not change the secret');
select ok((select count(*) > 0 from notesdb.vault_audit_events where request_id = 'c1000000-0000-4000-8000-000000000018' and not success and result_code = 'grant_denied'), 'grant denial is durably audited without returning plaintext');

create temporary table atomic_restored_grants on commit drop as
select public.qnotes_replace_vault_agent_grants(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->>'id' from atomic_token_a))::uuid,
  jsonb_build_array(jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'c1000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from atomic_secret_a))::uuid, 'action', 'secret:reveal'))
) as response;
select is((select response->>'status' from atomic_restored_grants), 'ok', 'the fixture grant can be restored');

create temporary table atomic_expired_token on commit drop as
select public.qnotes_create_vault_agent_token(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'expired atomic token',
  'qvt_AtomicB1',
  repeat('e', 64),
  clock_timestamp() - interval '1 second',
  jsonb_build_array(jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'c1000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from atomic_secret_a))::uuid, 'action', 'secret:reveal'))
) as response;
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from atomic_secret_a))::uuid,
  ((select response->>'id' from atomic_expired_token))::uuid,
  'expired synthetic reveal',
  'c1000000-0000-4000-8000-000000000019',
  'vault_agent'
)->>'status'), 'access_denied', 'an expired token fails closed at the locked authorization point');

create temporary table atomic_mixed_batch on commit drop as
select public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(
    jsonb_build_object('projectId', 'c1000000-0000-4000-8000-000000000001', 'environmentId', 'c1000000-0000-4000-8000-000000000002', 'secretId', ((select response->'secret'->>'id' from atomic_secret_a))),
    jsonb_build_object('projectId', 'd1000000-0000-4000-8000-000000000001', 'environmentId', 'd1000000-0000-4000-8000-000000000002', 'secretId', 'd1000000-0000-4000-8000-000000000099')
  ),
  ((select response->>'id' from atomic_token_a))::uuid,
  'mixed synthetic batch',
  'c1000000-0000-4000-8000-000000000020',
  'vault_agent'
) as response;
select ok((select response->>'status' <> 'ok' and not (response ? 'items') from atomic_mixed_batch), 'a mixed-authority batch returns no plaintext from the authorized selector');

create temporary table atomic_revocation on commit drop as
select public.qnotes_revoke_vault_agent_token(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->>'id' from atomic_token_a))::uuid
) as response;
select is((select response->>'status' from atomic_revocation), 'ok', 'token revocation obtains the same token lock');
select is((public.qnotes_vault_reveal_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from atomic_secret_a))::uuid,
  ((select response->>'id' from atomic_token_a))::uuid,
  'revoked synthetic reveal',
  'c1000000-0000-4000-8000-000000000021',
  'vault_agent'
)->>'status'), 'access_denied', 'a request authorized after revocation commits returns no secret');
select ok((select count(*) > 0 from notesdb.vault_audit_events where request_id = 'c1000000-0000-4000-8000-000000000021' and not success and result_code = 'token_invalid'), 'revocation denial is durably audited');

select * from finish();
rollback;
