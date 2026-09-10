begin;
select plan(30);

select has_column('notesdb', 'vault_mutations', 'project_id', 'mutation receipts retain the project identity');
select has_column('notesdb', 'vault_mutations', 'environment_id', 'mutation receipts retain the environment identity');
select has_column('notesdb', 'vault_mutations', 'expected_version', 'mutation receipts retain the expected version');
select has_column('notesdb', 'vault_mutations', 'actor_kind', 'mutation receipts retain the actor kind');
select has_column('notesdb', 'vault_mutations', 'actor_token_id', 'mutation receipts retain the actor token identity');
select has_column('notesdb', 'vault_mutations', 'retention_expires_at', 'mutation receipts have bounded retention');
select has_column('notesdb', 'vault_mutations', 'hash_key_version', 'mutation receipts record the hash construction version');
select ok(to_regprocedure('public.qnotes_vault_lock_mutation(uuid,uuid)') is not null, 'the mutation claim lock RPC exists');
select ok(to_regprocedure('public.qnotes_vault_get_mutation_receipt(uuid,uuid,text,uuid,uuid,uuid,bigint,text[],uuid,text,uuid)') is not null, 'the mutation receipt RPC exists');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_get_mutation_receipt(uuid,uuid,text,uuid,uuid,uuid,bigint,text[],uuid,text,uuid)', 'EXECUTE'), 'service_role can inspect authorized mutation receipts');
select ok(not has_function_privilege('authenticated', 'public.qnotes_vault_get_mutation_receipt(uuid,uuid,text,uuid,uuid,uuid,bigint,text[],uuid,text,uuid)', 'EXECUTE'), 'authenticated cannot call the receipt RPC directly');

insert into notesdb.vault_projects (id, owner_id, slug, name)
values ('a1700000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'receipt-owner', 'Synthetic receipt owner');

insert into notesdb.vault_environments (id, owner_id, project_id, slug, name)
values ('a1700000-0000-4000-8000-000000000002', (select id from auth.users where email = 'owner@qnotes.local'), 'a1700000-0000-4000-8000-000000000001', 'receipt-test', 'Synthetic receipt environment');

create temporary table vault_receipt_create on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000001',
  'a1700000-0000-4000-8000-000000000002',
  'RECEIPT_TARGET',
  'synthetic receipt metadata',
  'synthetic-replay-value',
  'a1700000-0000-4000-8000-000000000011',
  repeat('a', 64),
  null,
  'a1700000-0000-4000-8000-000000000012',
  'user_jwt'
) as response;

select is((select response->>'status' from vault_receipt_create), 'ok', 'a receipt test secret can be created');
select is((select hash_key_version from notesdb.vault_mutations where mutation_id = 'a1700000-0000-4000-8000-000000000011'), 'v1', 'new receipts use the versioned mutation hash construction');

create temporary table vault_receipt_delete on commit drop as
select public.qnotes_vault_delete_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_receipt_create))::uuid,
  1,
  'a1700000-0000-4000-8000-000000000021',
  repeat('b', 64),
  null,
  'a1700000-0000-4000-8000-000000000022',
  'user_jwt'
) as response;

select is((select response->>'status' from vault_receipt_delete), 'ok', 'the first delete writes its receipt');
select is((select count(*)::integer from notesdb.vault_mutations where mutation_id = 'a1700000-0000-4000-8000-000000000021'), 1, 'the first delete writes one receipt');

create temporary table vault_receipt_status on commit drop as
select public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  null, null, null, null, null, null, null, 'user_jwt',
  'a1700000-0000-4000-8000-000000000023'
) as response;

select is((select response->>'status' from vault_receipt_status), 'complete', 'status recovers a committed receipt after deletion');
select ok((select response->'result'->>'deletedAt' from vault_receipt_status) is not null, 'status returns the safe deletion tombstone');
select ok((select response::text from vault_receipt_status) !~ 'synthetic-replay-value', 'receipt status never returns a historical secret value');

select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  'deleted', null, null, ((select response->'secret'->>'id' from vault_receipt_create))::uuid, 1,
  array[repeat('b', 64)], null, 'user_jwt', 'a1700000-0000-4000-8000-000000000024'
)->>'status'), 'idempotent', 'an identical delete retry returns the original receipt');
select is((select version from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_receipt_create))::uuid), 2::bigint, 'a delete retry does not mutate the version again');
select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  'deleted', null, null, ((select response->'secret'->>'id' from vault_receipt_create))::uuid, 1,
  array[repeat('c', 64)], null, 'user_jwt', 'a1700000-0000-4000-8000-000000000025'
)->>'status'), 'mutation_reuse_conflict', 'a changed request hash with the same mutation ID is rejected');
select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  'deleted', null, null, ((select response->'secret'->>'id' from vault_receipt_create))::uuid, 2,
  array[repeat('b', 64)], null, 'user_jwt', 'a1700000-0000-4000-8000-000000000026'
)->>'status'), 'mutation_reuse_conflict', 'a changed expected version with the same mutation ID is rejected');
select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'other@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  null, null, null, null, null, null, null, 'user_jwt', 'b1700000-0000-4000-8000-000000000021'
)->>'status'), 'not_found', 'another owner cannot inspect the receipt');

insert into notesdb.vault_agent_tokens (id, owner_id, name, token_prefix, token_hash, expires_at)
values ('a1700000-0000-4000-8000-000000000031', (select id from auth.users where email = 'owner@qnotes.local'), 'Receipt status agent', 'qvt_RCPTEST1', repeat('d', 64), clock_timestamp() + interval '1 hour');
insert into notesdb.vault_agent_grants (owner_id, token_id, project_id, environment_id, secret_id, action)
values ((select id from auth.users where email = 'owner@qnotes.local'), 'a1700000-0000-4000-8000-000000000031', 'a1700000-0000-4000-8000-000000000001', 'a1700000-0000-4000-8000-000000000002', ((select response->'secret'->>'id' from vault_receipt_create))::uuid, 'secret:delete');

select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  null, null, null, null, null, null, 'a1700000-0000-4000-8000-000000000031', 'vault_agent', 'a1700000-0000-4000-8000-000000000032'
)->>'status'), 'complete', 'an active exact delete grant can inspect its receipt');
delete from notesdb.vault_agent_grants where token_id = 'a1700000-0000-4000-8000-000000000031';
select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  null, null, null, null, null, null, 'a1700000-0000-4000-8000-000000000031', 'vault_agent', 'a1700000-0000-4000-8000-000000000033'
)->>'status'), 'access_denied', 'receipt status follows current grant revocation');

update notesdb.vault_mutations
set created_at = clock_timestamp() - interval '31 days',
    retention_expires_at = clock_timestamp() - interval '1 second'
where mutation_id = 'a1700000-0000-4000-8000-000000000021';
select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  null, null, null, null, null, null, null, 'user_jwt', 'a1700000-0000-4000-8000-000000000034'
)->>'status'), 'expired', 'expired receipt retention is reported explicitly');
select ok((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000021',
  null, null, null, null, null, null, null, 'user_jwt', 'a1700000-0000-4000-8000-000000000035'
)->>'result') is null, 'an expired receipt does not return its old result');

create temporary table vault_receipt_legacy_create on commit drop as
select public.qnotes_vault_create_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000001',
  'a1700000-0000-4000-8000-000000000002',
  'LEGACY_ROTATION_TARGET',
  'synthetic legacy metadata',
  'synthetic-legacy-value',
  'a1700000-0000-4000-8000-000000000041',
  repeat('e', 64),
  null,
  'a1700000-0000-4000-8000-000000000042',
  'user_jwt'
) as response;

select is((public.qnotes_vault_rotate_secret(
  (select id from auth.users where email = 'owner@qnotes.local'),
  ((select response->'secret'->>'id' from vault_receipt_legacy_create))::uuid,
  'synthetic-legacy-rotated',
  'synthetic legacy rotation',
  1,
  'a1700000-0000-4000-8000-000000000051',
  repeat('e', 64),
  null,
  'a1700000-0000-4000-8000-000000000052',
  'user_jwt'
)->>'status'), 'ok', 'the legacy rotate shape creates a receipt');
select is((public.qnotes_vault_get_mutation_receipt(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a1700000-0000-4000-8000-000000000051',
  'rotated', null, null, ((select response->'secret'->>'id' from vault_receipt_legacy_create))::uuid, 1,
  array[repeat('f', 64), repeat('e', 64)], null, 'user_jwt', 'a1700000-0000-4000-8000-000000000053'
)->>'status'), 'idempotent', 'the receipt lookup accepts the supported legacy rotation hash');
select is((select version from notesdb.vault_secrets where id = ((select response->'secret'->>'id' from vault_receipt_legacy_create))::uuid), 2::bigint, 'legacy rotation replay does not apply a second change');

select * from finish();
rollback;
