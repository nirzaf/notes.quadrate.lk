begin;
select plan(29);

select ok(to_regprocedure('public.qnotes_vault_reveal_secrets(uuid,jsonb,uuid,text,uuid,text)') is not null, 'Vault batch reveal RPC exists');
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.qnotes_vault_reveal_secrets(uuid,jsonb,uuid,text,uuid,text)'::regprocedure), 'Vault batch reveal RPC is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.qnotes_vault_reveal_secrets(uuid,jsonb,uuid,text,uuid,text)', 'EXECUTE'), 'anon cannot execute the Vault batch reveal RPC');
select ok(not has_function_privilege('authenticated', 'public.qnotes_vault_reveal_secrets(uuid,jsonb,uuid,text,uuid,text)', 'EXECUTE'), 'authenticated cannot execute the Vault batch reveal RPC');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_reveal_secrets(uuid,jsonb,uuid,text,uuid,text)', 'EXECUTE'), 'service_role can execute the Vault batch reveal RPC');

insert into notesdb.vault_projects (id, owner_id, slug, name)
values
  ('a2000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'batch-owner-a', 'Synthetic batch owner A'),
  ('b2000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'other@qnotes.local'), 'batch-owner-b', 'Synthetic batch owner B');

insert into notesdb.vault_environments (id, owner_id, project_id, slug, name)
values
  ('a2000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'a2000000-0000-4000-8000-000000000001', 'batch-a', 'Synthetic batch A environment'),
  ('b2000000-0000-4000-8000-000000000002', (select id from auth.users where email = 'other@qnotes.local'), 'b2000000-0000-4000-8000-000000000001', 'batch-b', 'Synthetic batch B environment');

create temporary table vault_batch_create_a1 on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000002',
  'BATCH_ONE', 'synthetic batch metadata one', 'synthetic-batch-value-one',
  'a2000000-0000-4000-8000-000000000011', repeat('1', 64), null,
  'a2000000-0000-4000-8000-000000000012', 'user_jwt'
) as response;
select is((select response->>'status' from vault_batch_create_a1), 'ok', 'first batch fixture create returns ok');

create temporary table vault_batch_create_a2 on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000002',
  'BATCH_TWO', 'synthetic batch metadata two', 'synthetic-batch-value-two',
  'a2000000-0000-4000-8000-000000000013', repeat('2', 64), null,
  'a2000000-0000-4000-8000-000000000014', 'user_jwt'
) as response;
select is((select response->>'status' from vault_batch_create_a2), 'ok', 'second batch fixture create returns ok');

create temporary table vault_batch_create_b on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'other@qnotes.local'),
  'b2000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000002',
  'OWNER_B_BATCH', 'synthetic owner B batch metadata', 'synthetic-owner-b-batch-value',
  'b2000000-0000-4000-8000-000000000011', repeat('3', 64), null,
  'b2000000-0000-4000-8000-000000000012', 'user_jwt'
) as response;
select is((select response->>'status' from vault_batch_create_b), 'ok', 'cross-owner batch fixture create returns ok');

create temporary table vault_batch_success on commit drop as
select public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(
    jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_a1))::uuid),
    jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_a2))::uuid)
  ), null, 'synthetic batch success purpose', 'a2000000-0000-4000-8000-000000000021', 'user_jwt'
) as response;
select is((select response->>'status' from vault_batch_success), 'ok', 'a multi-item batch reveal returns ok');
select is((select jsonb_array_length(response->'items')::integer from vault_batch_success), 2, 'a successful batch returns both items');
select is((select response->'items'->0->>'value' from vault_batch_success), 'synthetic-batch-value-one', 'the first batch value is returned in selector order');
select is((select response->'items'->1->>'value' from vault_batch_success), 'synthetic-batch-value-two', 'the second batch value is returned in selector order');
select is((select count(*)::integer from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000021' and action = 'secret:reveal' and success and result_code = 'revealed'), 2, 'a successful batch writes all success audits');
select ok((select bool_and(actor_kind = 'user_jwt' and actor_token_id is null and purpose = 'synthetic batch success purpose') from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000021'), 'batch success audits preserve actor and purpose attribution');
select ok((select not exists (select 1 from notesdb.vault_audit_events e where e.request_id = 'a2000000-0000-4000-8000-000000000021' and row_to_json(e)::text like '%synthetic-batch-value%')), 'batch audit rows contain no plaintext values');

create temporary table vault_batch_large_creates on commit drop as
select public.qnotes_vault_create_secret((select id from auth.users where email = 'owner@qnotes.local'), 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'BATCH_LARGE_01', 'synthetic oversized batch fixture', repeat('a', 65536), 'a2000000-0000-4000-8000-000000000031', repeat('4', 64), null, 'a2000000-0000-4000-8000-000000000032', 'user_jwt') as response
union all select public.qnotes_vault_create_secret((select id from auth.users where email = 'owner@qnotes.local'), 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'BATCH_LARGE_02', 'synthetic oversized batch fixture', repeat('b', 65536), 'a2000000-0000-4000-8000-000000000033', repeat('5', 64), null, 'a2000000-0000-4000-8000-000000000034', 'user_jwt')
union all select public.qnotes_vault_create_secret((select id from auth.users where email = 'owner@qnotes.local'), 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'BATCH_LARGE_03', 'synthetic oversized batch fixture', repeat('c', 65536), 'a2000000-0000-4000-8000-000000000035', repeat('6', 64), null, 'a2000000-0000-4000-8000-000000000036', 'user_jwt')
union all select public.qnotes_vault_create_secret((select id from auth.users where email = 'owner@qnotes.local'), 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'BATCH_LARGE_04', 'synthetic oversized batch fixture', repeat('d', 65536), 'a2000000-0000-4000-8000-000000000037', repeat('7', 64), null, 'a2000000-0000-4000-8000-000000000038', 'user_jwt')
union all select public.qnotes_vault_create_secret((select id from auth.users where email = 'owner@qnotes.local'), 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'BATCH_LARGE_05', 'synthetic oversized batch fixture', repeat('e', 65536), 'a2000000-0000-4000-8000-000000000039', repeat('8', 64), null, 'a2000000-0000-4000-8000-000000000040', 'user_jwt');
select ok((select bool_and(response->>'status' = 'ok') from vault_batch_large_creates), 'maximum-size synthetic secrets can be created for the aggregate test');

create temporary table vault_batch_oversized on commit drop as
select public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  (select jsonb_agg(jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', s.id) order by s.name) from notesdb.vault_secrets s where s.owner_id = (select id from auth.users where email = 'owner@qnotes.local') and s.name like 'BATCH_LARGE_%'),
  null, 'synthetic oversized batch purpose', 'a2000000-0000-4000-8000-000000000041', 'user_jwt'
) as response;
select is((select response->>'status' from vault_batch_oversized), 'batch_too_large', 'an oversized batch fails before success audits');
select is((select count(*)::integer from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000041' and action = 'secret:reveal' and success), 0, 'an oversized batch writes no success audits');
select ok((select not exists (select 1 from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000041')), 'an oversized batch writes no audit rows');

select is((public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(jsonb_build_object('projectId', 'not-a-uuid', 'environmentId', 'a2000000-0000-4000-8000-000000000002', 'secretId', 'not-a-uuid')),
  null, 'synthetic invalid selector purpose', 'a2000000-0000-4000-8000-000000000051', 'user_jwt'
)->>'status'), 'invalid_selectors', 'an invalid selector is rejected without resolving a secret');
select is((select count(*)::integer from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000051'), 0, 'an invalid selector writes no audit rows');

select is((public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  (select jsonb_agg(jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_a1))::uuid)) from generate_series(1, 21)),
  null, 'synthetic too many selectors purpose', 'a2000000-0000-4000-8000-000000000061', 'user_jwt'
)->>'status'), 'invalid_selectors', 'the batch RPC preserves the twenty-selector limit');
select is((select count(*)::integer from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000061'), 0, 'an over-bound selector list writes no audit rows');

select is((public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(jsonb_build_object('projectId', 'b2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'b2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_b))::uuid)),
  null, 'synthetic cross-owner selector purpose', 'a2000000-0000-4000-8000-000000000071', 'user_jwt'
)->>'status'), 'not_found', 'a cross-owner selector is isolated as not found');
select is((select count(*)::integer from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000071'), 0, 'a cross-owner selector writes no audit rows');

create function pg_temp.fail_vault_batch_audit_insert() returns trigger
language plpgsql
as $$
begin
  if new.request_id = 'a2000000-0000-4000-8000-000000000081'::uuid then raise exception 'synthetic Vault batch audit failure'; end if;
  return new;
end;
$$;

create trigger vault_batch_test_fail_audit
before insert on notesdb.vault_audit_events
for each row execute function pg_temp.fail_vault_batch_audit_insert();

create function pg_temp.vault_batch_audit_failure_returns() returns boolean
language plpgsql
as $$
begin
  perform public.qnotes_vault_reveal_secrets(
    (select id from auth.users where email = 'owner@qnotes.local'),
    jsonb_build_array(
      jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_a1))::uuid),
      jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_a2))::uuid)
    ), null, 'synthetic forced batch audit failure', 'a2000000-0000-4000-8000-000000000081', 'user_jwt'
  );
  return true;
exception when others then
  if position('synthetic Vault batch audit failure' in sqlerrm) > 0 then return false; end if;
  raise;
end;
$$;
select ok(not pg_temp.vault_batch_audit_failure_returns(), 'a batch audit insertion failure prevents a successful return');
select ok((select not exists (select 1 from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000081')), 'a failed batch audit insertion rolls back every audit row');

drop trigger vault_batch_test_fail_audit on notesdb.vault_audit_events;
select is((public.qnotes_vault_reveal_secrets(
  (select id from auth.users where email = 'owner@qnotes.local'),
  jsonb_build_array(jsonb_build_object('projectId', 'a2000000-0000-4000-8000-000000000001'::uuid, 'environmentId', 'a2000000-0000-4000-8000-000000000002'::uuid, 'secretId', ((select response->'secret'->>'id' from vault_batch_create_a1))::uuid)),
  null, 'synthetic post-failure batch reveal', 'a2000000-0000-4000-8000-000000000082', 'user_jwt'
)->>'status'), 'ok', 'a batch fixture remains available after an audit rollback');
select is((select count(*)::integer from notesdb.vault_audit_events where request_id = 'a2000000-0000-4000-8000-000000000082' and success and result_code = 'revealed'), 1, 'a later batch reveal writes its success audit');

select * from finish();
rollback;
