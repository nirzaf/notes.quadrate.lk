begin;
select plan(33);

select has_table('notesdb', 'vault_audit_policy', 'Vault audit policy exists');
select has_table('notesdb', 'vault_audit_outbox', 'Vault audit outbox exists');
select has_column('notesdb', 'vault_audit_events', 'policy_revision', 'audit events record the policy revision');
select has_column('notesdb', 'vault_audit_events', 'operation_id', 'audit events record the operation identity');
select has_column('notesdb', 'vault_audit_events', 'retention_expires_at', 'audit events have an explicit retention deadline');
select has_column('notesdb', 'vault_audit_events', 'target_token_id', 'audit events identify targeted agent tokens safely');
select has_column('notesdb', 'vault_audit_outbox', 'lease_token', 'outbox claims have fencing tokens');
select ok((select retention_days = 2555 from notesdb.vault_audit_policy where policy_id), 'the default audit retention is seven years');
select ok(not exists (
  select 1 from pg_constraint
  where conrelid = 'notesdb.vault_audit_events'::regclass
    and contype = 'f'
    and confrelid = 'auth.users'::regclass
), 'audit rows do not cascade away when an account is deleted');

select ok(has_function_privilege('service_role', 'public.qnotes_vault_append_audit_event(uuid,text,uuid,text,uuid,uuid,uuid,text,boolean,text,uuid,uuid,uuid)', 'EXECUTE'), 'service_role can use the controlled audit writer');
select ok(not has_function_privilege('anon', 'public.qnotes_vault_append_audit_event(uuid,text,uuid,text,uuid,uuid,uuid,text,boolean,text,uuid,uuid,uuid)', 'EXECUTE'), 'anon cannot use the controlled audit writer');
select ok(has_table_privilege('service_role', 'notesdb.vault_audit_events', 'SELECT'), 'service_role can read audit events');
select ok(not has_table_privilege('service_role', 'notesdb.vault_audit_events', 'INSERT,UPDATE,DELETE'), 'service_role cannot edit audit rows directly');
select ok(not has_function_privilege('service_role', 'public.qnotes_vault_purge_expired_audit_events(timestamptz)', 'EXECUTE'), 'service_role cannot invoke the retention purge');

create temporary table audit_integrity_event on commit drop as
select public.qnotes_vault_append_audit_event(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'system', null, 'admin:recovery', null, null, null,
  'synthetic maintenance recovery', false, 'recovery_required',
  'a8000000-0000-4000-8000-000000000001',
  'a8000000-0000-4000-8000-000000000001',
  'a8000000-0000-4000-8000-000000000003'
) as event_id;

select ok((select event_id is not null from audit_integrity_event), 'the controlled writer returns an event identity');
select ok((select action = 'admin:recovery' and actor_kind = 'system' and not success and policy_revision = 'vault-audit-v1'
  and target_token_id = 'a8000000-0000-4000-8000-000000000003'::uuid
  from notesdb.vault_audit_events where id = (select event_id from audit_integrity_event)), 'administrative recovery events carry safe typed metadata');
select ok((select event_id = (select event_id from audit_integrity_event) and payload->>'action' = 'admin:recovery'
  and payload->>'targetTokenId' = 'a8000000-0000-4000-8000-000000000003'
  from notesdb.vault_audit_outbox where event_id = (select event_id from audit_integrity_event)), 'every event is durably queued for export without secret fields');
select ok((select not (payload ? 'value') and not (payload ? 'requestBody') from notesdb.vault_audit_outbox where event_id = (select event_id from audit_integrity_event)), 'the export payload excludes secret values and whole requests');

select throws_ok($$update notesdb.vault_audit_events set purpose = 'tampered' where id = (select event_id from audit_integrity_event)$$, 'P0001', 'Vault audit events are append-only', 'the broker cannot update prior audit rows');
select throws_ok($$delete from notesdb.vault_audit_events where id = (select event_id from audit_integrity_event)$$, 'P0001', 'Vault audit events are append-only', 'the broker cannot delete prior audit rows');

create temporary table audit_integrity_claim on commit drop as
select * from public.qnotes_vault_claim_audit_outbox(100);
select ok((select event_id in (select event_id from audit_integrity_claim) from audit_integrity_event), 'the bounded exporter claim returns the event');
select ok((select attempts = 1 and leased_until is not null and lease_token is not null from notesdb.vault_audit_outbox where event_id = (select event_id from audit_integrity_event)), 'claims increment attempts and fence the event');
select is(public.qnotes_vault_retry_audit_outbox((select event_id from audit_integrity_event), gen_random_uuid(), 'synthetic exporter unavailable'), false, 'a stale exporter cannot retry a lease');
select is(public.qnotes_vault_retry_audit_outbox((select event_id from audit_integrity_event), (select lease_token from audit_integrity_claim where event_id = (select event_id from audit_integrity_event)), 'synthetic exporter unavailable'), true, 'export failure remains retryable');
select ok((select last_error = 'synthetic exporter unavailable' and exported_at is null and leased_until is null from notesdb.vault_audit_outbox where event_id = (select event_id from audit_integrity_event)), 'retry records bounded lag metadata without losing the event');
select is(public.qnotes_vault_ack_audit_outbox((select event_id from audit_integrity_event), (select lease_token from audit_integrity_claim where event_id = (select event_id from audit_integrity_event))), false, 'a retried lease cannot be acknowledged by its stale claim');

create temporary table audit_integrity_ack_event on commit drop as
select public.qnotes_vault_append_audit_event(
  (select id from auth.users where email = 'owner@qnotes.local'),
  'system', null, 'admin:recovery', null, null, null,
  'synthetic acknowledgement', false, 'recovery_required',
  'a8000000-0000-4000-8000-000000000002',
  'a8000000-0000-4000-8000-000000000002',
  null
) as event_id;
create temporary table audit_integrity_ack_claim on commit drop as
select * from public.qnotes_vault_claim_audit_outbox(100)
where event_id = (select event_id from audit_integrity_ack_event);
select is(public.qnotes_vault_ack_audit_outbox((select event_id from audit_integrity_ack_event), (select lease_token from audit_integrity_ack_claim)), true, 'a current export lease can acknowledge the event');
select ok((select exported_at is not null and lease_token is null from notesdb.vault_audit_outbox where event_id = (select event_id from audit_integrity_ack_event)), 'acknowledged events retain export evidence and clear the lease');
-- Expire only these synthetic fixtures; production audit rows remain append-only.
alter table notesdb.vault_audit_events disable trigger vault_audit_events_append_only;
update notesdb.vault_audit_events set retention_expires_at = clock_timestamp() - interval '1 second' where id = (select event_id from audit_integrity_event);
alter table notesdb.vault_audit_events enable trigger vault_audit_events_append_only;
select is(public.qnotes_vault_purge_expired_audit_events(clock_timestamp()), 0, 'retention purge preserves an event with an unacknowledged export');
alter table notesdb.vault_audit_events disable trigger vault_audit_events_append_only;
update notesdb.vault_audit_events set retention_expires_at = clock_timestamp() - interval '1 second' where id = (select event_id from audit_integrity_ack_event);
alter table notesdb.vault_audit_events enable trigger vault_audit_events_append_only;
select is(public.qnotes_vault_purge_expired_audit_events(clock_timestamp()), 1, 'retention purge removes an expired event after export acknowledgement');

select ok(has_function_privilege('service_role', 'public.qnotes_vault_claim_audit_outbox(integer)', 'EXECUTE'), 'service_role can claim outbox work without table update access');
select ok(has_function_privilege('service_role', 'public.qnotes_vault_retry_audit_outbox(uuid,uuid,text)', 'EXECUTE'), 'service_role can retry outbox work without table update access');
select ok(has_function_privilege('qnotes_vault_audit_maintenance', 'public.qnotes_vault_purge_expired_audit_events(timestamptz)', 'EXECUTE'), 'only the maintenance role can invoke retention purge');

select * from finish();
rollback;
