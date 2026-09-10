begin;
select plan(18);

select ok(to_regclass('notesdb.vault_security_policy') is not null, 'Vault security policy table exists');
select ok(to_regclass('notesdb.vault_operation_approvals') is not null, 'Vault operation approval table exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'notesdb' and c.relname = 'vault_operation_approvals'), 'operation approvals use RLS');
select ok(not has_table_privilege('authenticated', 'notesdb.vault_operation_approvals', 'SELECT'), 'authenticated cannot read operation approvals');
select ok(has_table_privilege('service_role', 'notesdb.vault_operation_approvals', 'SELECT,INSERT,UPDATE,DELETE'), 'service_role can manage operation approvals');
select is((select max_agent_token_lifetime_seconds from notesdb.vault_security_policy where policy_id), 7776000::bigint, 'the configured new agent lifetime cap is ninety days');
select ok(has_function_privilege('service_role', 'public.qnotes_issue_vault_operation_approval(uuid,uuid,text,uuid,uuid,uuid,bigint,text,text)', 'EXECUTE'), 'service_role can issue approvals');
select ok(not has_function_privilege('authenticated', 'public.qnotes_issue_vault_operation_approval(uuid,uuid,text,uuid,uuid,uuid,bigint,text,text)', 'EXECUTE'), 'authenticated cannot issue approvals directly');
select ok(has_function_privilege('service_role', 'public.qnotes_consume_vault_operation_approval(uuid,uuid,text,uuid,uuid,uuid,bigint,text,text)', 'EXECUTE'), 'service_role can consume approvals');

insert into notesdb.vault_projects (id, owner_id, slug, name)
values ('a5000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'owner@qnotes.local'), 'us05-owner', 'US05 owner');

select throws_ok($$select public.qnotes_create_vault_agent_token((select id from auth.users where email = 'owner@qnotes.local'), 'missing expiry', 'qvt_US05A001', repeat('a', 64), null, jsonb_build_array(jsonb_build_object('projectId', 'a5000000-0000-4000-8000-000000000001'::uuid, 'environmentId', null, 'secretId', null, 'action', 'metadata:read')))$$, 'P0001', 'Vault agent token expiry is outside the configured policy', 'new agent tokens reject a missing expiry');
select throws_ok($$select public.qnotes_create_vault_agent_token((select id from auth.users where email = 'owner@qnotes.local'), 'long expiry', 'qvt_US05A002', repeat('b', 64), clock_timestamp() + interval '91 days', jsonb_build_array(jsonb_build_object('projectId', 'a5000000-0000-4000-8000-000000000001'::uuid, 'environmentId', null, 'secretId', null, 'action', 'metadata:read')))$$, 'P0001', 'Vault agent token expiry is outside the configured policy', 'new agent tokens reject an expiry beyond the configured cap');
select ok((public.qnotes_create_vault_agent_token((select id from auth.users where email = 'owner@qnotes.local'), 'bounded token', 'qvt_US05A003', repeat('c', 64), clock_timestamp() + interval '1 hour', jsonb_build_array(jsonb_build_object('projectId', 'a5000000-0000-4000-8000-000000000001'::uuid, 'environmentId', null, 'secretId', null, 'action', 'metadata:read')))->>'expiresAt') is not null, 'a future agent token inside the cap is accepted');

create temporary table us05_approval on commit drop as
select public.qnotes_issue_vault_operation_approval(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'a5000000-0000-4000-8000-000000000011',
  'secret:reveal',
  'a5000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000002',
  'a5000000-0000-4000-8000-000000000003',
  2,
  repeat('d', 64),
  repeat('e', 64)
) as response;
select is((select response->>'status' from us05_approval), 'ok', 'a step-up approval is issued with a bounded expiry');
select ok((select (response->>'expiresAt')::timestamptz > clock_timestamp() from us05_approval), 'issued approval expiry is in the future');
select is((public.qnotes_consume_vault_operation_approval((select id from auth.users where email = 'owner@qnotes.local'), 'a5000000-0000-4000-8000-000000000011', 'secret:reveal', 'a5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000003', 2, repeat('d', 64), repeat('e', 64))->>'status'), 'ok', 'an approval is consumed for its exact session, action, resource, version, and digest');
select is((public.qnotes_consume_vault_operation_approval((select id from auth.users where email = 'owner@qnotes.local'), 'a5000000-0000-4000-8000-000000000011', 'secret:reveal', 'a5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000003', 2, repeat('d', 64), repeat('e', 64))->>'status'), 'used', 'an approval cannot be replayed');

create temporary table us05_expiring_approval on commit drop as
select public.qnotes_issue_vault_operation_approval((select id from auth.users where email = 'owner@qnotes.local'), 'a5000000-0000-4000-8000-000000000012', 'secret:write', null, null, null, null, repeat('f', 64), repeat('1', 64)) as response;
select is((public.qnotes_consume_vault_operation_approval((select id from auth.users where email = 'owner@qnotes.local'), 'a5000000-0000-4000-8000-000000000012', 'secret:write', null, null, null, null, repeat('0', 64), repeat('1', 64))->>'status'), 'invalid', 'a changed request digest is rejected');
update notesdb.vault_operation_approvals set expires_at = clock_timestamp() - interval '1 second' where approval_hash = repeat('1', 64);
select is((public.qnotes_consume_vault_operation_approval((select id from auth.users where email = 'owner@qnotes.local'), 'a5000000-0000-4000-8000-000000000012', 'secret:write', null, null, null, null, repeat('f', 64), repeat('1', 64))->>'status'), 'expired', 'an expired approval fails closed');

select * from finish();
rollback;
