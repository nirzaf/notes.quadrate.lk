-- US-13 follow-up: fence audit exports and keep successful Vault mutations
-- and their audit records in the same database transaction.

alter table notesdb.vault_audit_events
  add column if not exists target_token_id uuid;

create index if not exists vault_audit_target_token_key
  on notesdb.vault_audit_events (target_token_id)
  where target_token_id is not null;

create or replace function notesdb.vault_audit_metadata_defaults()
returns trigger
language plpgsql
security definer
set search_path = notesdb, pg_temp
as $$
declare
  policy_row notesdb.vault_audit_policy%rowtype;
begin
  select * into policy_row
  from notesdb.vault_audit_policy
  where policy_id
  for share;
  if not found then raise exception 'Vault audit policy is unavailable'; end if;

  new.operation_id := coalesce(new.operation_id, new.request_id);
  new.policy_revision := policy_row.policy_revision;
  new.retention_expires_at := clock_timestamp() + make_interval(days => policy_row.retention_days);
  return new;
end;
$$;

alter function notesdb.vault_audit_metadata_defaults() owner to qnotes_vault_audit_maintenance;

drop trigger if exists vault_audit_events_metadata_defaults on notesdb.vault_audit_events;
create trigger vault_audit_events_metadata_defaults
before insert on notesdb.vault_audit_events
for each row execute function notesdb.vault_audit_metadata_defaults();

create or replace function notesdb.vault_audit_outbox_insert()
returns trigger
language plpgsql
security definer
set search_path = notesdb, pg_temp
as $$
begin
  insert into notesdb.vault_audit_outbox (event_id, owner_id, payload)
  values (
    new.id,
    new.owner_id,
    jsonb_build_object(
      'eventId', new.id,
      'ownerId', new.owner_id,
      'actorKind', new.actor_kind,
      'actorTokenId', new.actor_token_id,
      'targetTokenId', new.target_token_id,
      'action', new.action,
      'projectId', new.project_id,
      'environmentId', new.environment_id,
      'secretId', new.secret_id,
      'purpose', new.purpose,
      'success', new.success,
      'resultCode', new.result_code,
      'requestId', new.request_id,
      'operationId', new.operation_id,
      'policyRevision', new.policy_revision,
      'retentionExpiresAt', new.retention_expires_at,
      'occurredAt', new.occurred_at
    )
  )
  on conflict (event_id) do nothing;
  return new;
end;
$$;

alter function notesdb.vault_audit_outbox_insert() owner to qnotes_vault_audit_maintenance;

-- Backfill existing rows before the append-only trigger is active for normal writes.
alter table notesdb.vault_audit_events disable trigger vault_audit_events_append_only;
update notesdb.vault_audit_events
set operation_id = request_id
where operation_id is null
  and request_id is not null;
alter table notesdb.vault_audit_events enable trigger vault_audit_events_append_only;

update notesdb.vault_audit_outbox o
set payload = o.payload || jsonb_build_object(
  'targetTokenId', e.target_token_id,
  'operationId', e.operation_id,
  'retentionExpiresAt', e.retention_expires_at
)
from notesdb.vault_audit_events e
where e.id = o.event_id;

drop function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid);

create function public.qnotes_vault_append_audit_event(
  p_owner_id uuid,
  p_actor_kind text,
  p_actor_token_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_purpose text,
  p_success boolean,
  p_result_code text,
  p_request_id uuid,
  p_operation_id uuid,
  p_target_token_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  event_id uuid;
begin
  if p_owner_id is null
    or p_actor_kind not in ('user_jwt', 'vault_agent', 'system')
    or (p_actor_kind = 'vault_agent' and p_actor_token_id is null)
    or (p_actor_kind <> 'vault_agent' and p_actor_token_id is not null)
    or p_action not in (
      'metadata:read', 'secret:reveal', 'secret:write', 'secret:delete', 'secret:use',
      'token:issue', 'token:revoke', 'grant:replace', 'auth:step_up',
      'approval:issue', 'approval:consume', 'access:denied', 'admin:recovery'
    )
    or (p_purpose is not null and (char_length(p_purpose) < 1 or char_length(p_purpose) > 200 or p_purpose ~ '[\r\n]'))
    or (p_result_code is not null and p_result_code ~ '[\r\n]') then
    raise exception 'invalid Vault audit event';
  end if;

  insert into notesdb.vault_audit_events (
    owner_id, actor_kind, actor_token_id, target_token_id, action,
    project_id, environment_id, secret_id, purpose, success, result_code,
    request_id, operation_id
  ) values (
    p_owner_id, p_actor_kind, p_actor_token_id, p_target_token_id, p_action,
    p_project_id, p_environment_id, p_secret_id, p_purpose, coalesce(p_success, false),
    left(p_result_code, 120), p_request_id, coalesce(p_operation_id, p_request_id)
  ) returning id into event_id;
  return event_id;
end;
$$;

alter function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid, uuid) owner to qnotes_vault_audit_maintenance;

create function public.qnotes_vault_append_audit_event(
  p_owner_id uuid,
  p_actor_kind text,
  p_actor_token_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_purpose text,
  p_success boolean,
  p_result_code text,
  p_request_id uuid,
  p_operation_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  return public.qnotes_vault_append_audit_event(
    p_owner_id, p_actor_kind, p_actor_token_id, p_action, p_project_id,
    p_environment_id, p_secret_id, p_purpose, p_success, p_result_code,
    p_request_id, p_operation_id, null
  );
end;
$$;

alter function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) owner to qnotes_vault_audit_maintenance;

alter table notesdb.vault_audit_outbox
  add column if not exists lease_token uuid;

drop function public.qnotes_vault_claim_audit_outbox(integer);
drop function public.qnotes_vault_ack_audit_outbox(uuid);
drop function public.qnotes_vault_retry_audit_outbox(uuid, text);

create function public.qnotes_vault_claim_audit_outbox(p_limit integer default 50)
returns table(event_id uuid, payload jsonb, attempts integer, leased_until timestamptz, lease_token uuid)
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Vault audit outbox limit must be between 1 and 100';
  end if;
  return query
  with candidates as (
    select o.event_id
    from notesdb.vault_audit_outbox o
    where o.exported_at is null
      and o.available_at <= clock_timestamp()
      and (o.leased_until is null or o.leased_until <= clock_timestamp())
    order by o.created_at, o.event_id
    limit p_limit
    for update skip locked
  )
  update notesdb.vault_audit_outbox o
  set attempts = o.attempts + 1,
      leased_until = clock_timestamp() + interval '5 minutes',
      lease_token = gen_random_uuid(),
      last_error = null
  from candidates c
  where o.event_id = c.event_id
  returning o.event_id, o.payload, o.attempts, o.leased_until, o.lease_token;
end;
$$;

create function public.qnotes_vault_ack_audit_outbox(p_event_id uuid, p_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  update notesdb.vault_audit_outbox
  set exported_at = clock_timestamp(), leased_until = null, lease_token = null
  where event_id = p_event_id
    and lease_token = p_lease_token
    and leased_until > clock_timestamp()
    and exported_at is null;
  return found;
end;
$$;

create function public.qnotes_vault_retry_audit_outbox(p_event_id uuid, p_lease_token uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  update notesdb.vault_audit_outbox
  set available_at = clock_timestamp() + interval '60 seconds',
      leased_until = null,
      lease_token = null,
      last_error = left(regexp_replace(coalesce(p_error, 'export_failed'), '[\r\n]', '', 'g'), 200)
  where event_id = p_event_id
    and lease_token = p_lease_token
    and leased_until > clock_timestamp()
    and exported_at is null;
  return found;
end;
$$;

create or replace function public.qnotes_vault_purge_expired_audit_events(p_before timestamptz default clock_timestamp())
returns integer
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  removed integer;
begin
  perform set_config('qnotes.vault_audit_maintenance', 'on', true);
  delete from notesdb.vault_audit_events e
  where e.retention_expires_at <= least(coalesce(p_before, clock_timestamp()), clock_timestamp())
    and not exists (
      select 1
      from notesdb.vault_audit_outbox o
      where o.event_id = e.id
        and o.exported_at is null
    );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

alter function public.qnotes_vault_claim_audit_outbox(integer) owner to qnotes_vault_audit_maintenance;
alter function public.qnotes_vault_ack_audit_outbox(uuid, uuid) owner to qnotes_vault_audit_maintenance;
alter function public.qnotes_vault_retry_audit_outbox(uuid, uuid, text) owner to qnotes_vault_audit_maintenance;
alter function public.qnotes_vault_purge_expired_audit_events(timestamptz) owner to qnotes_vault_audit_maintenance;

revoke all on function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_vault_claim_audit_outbox(integer) from public, anon, authenticated;
revoke all on function public.qnotes_vault_ack_audit_outbox(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_vault_retry_audit_outbox(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qnotes_vault_purge_expired_audit_events(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid, uuid) to service_role;
grant execute on function public.qnotes_vault_claim_audit_outbox(integer) to service_role;
grant execute on function public.qnotes_vault_ack_audit_outbox(uuid, uuid) to service_role;
grant execute on function public.qnotes_vault_retry_audit_outbox(uuid, uuid, text) to service_role;
grant execute on function public.qnotes_vault_purge_expired_audit_events(timestamptz) to qnotes_vault_audit_maintenance;

drop function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb);
create function public.qnotes_create_vault_agent_token(
  p_owner_id uuid,
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_grants jsonb,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  token_row notesdb.vault_agent_tokens%rowtype;
  grant_item jsonb;
  grant_row notesdb.vault_agent_grants%rowtype;
  grants jsonb := '[]'::jsonb;
  max_lifetime bigint;
begin
  select max_agent_token_lifetime_seconds into max_lifetime
  from notesdb.vault_security_policy
  where policy_id;
  if max_lifetime is null
    or p_expires_at is null
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + (max_lifetime * interval '1 second') then
    raise exception 'Vault agent token expiry is outside the configured policy';
  end if;
  if p_name is null or char_length(p_name) < 1 or char_length(p_name) > 80 or p_token_prefix !~ '^qvt_[A-Za-z0-9_-]{8}$' or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid Vault agent token metadata'; end if;
  insert into notesdb.vault_agent_tokens (owner_id, name, token_prefix, token_hash, expires_at)
  values (p_owner_id, p_name, p_token_prefix, p_token_hash, p_expires_at)
  returning * into token_row;
  for grant_item in select value from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) loop
    if (grant_item->>'secretId' is not null and grant_item->>'secretId' <> '' and (grant_item->>'environmentId' is null or grant_item->>'environmentId' = '')) then
      raise exception 'Vault secret grant requires an environment';
    end if;
    insert into notesdb.vault_agent_grants (owner_id, token_id, project_id, environment_id, secret_id, action)
    values (p_owner_id, token_row.id, (grant_item->>'projectId')::uuid, nullif(grant_item->>'environmentId', '')::uuid, nullif(grant_item->>'secretId', '')::uuid, grant_item->>'action')
    returning * into grant_row;
    grants := grants || jsonb_build_array(jsonb_build_object('id', grant_row.id, 'projectId', grant_row.project_id, 'environmentId', grant_row.environment_id, 'secretId', grant_row.secret_id, 'action', grant_row.action, 'createdAt', grant_row.created_at));
  end loop;
  perform public.qnotes_vault_append_audit_event(p_owner_id, 'user_jwt', null, 'token:issue', null, null, null, 'Vault agent token issued', true, 'issued', p_request_id, p_request_id, token_row.id);
  return jsonb_build_object('id', token_row.id, 'name', token_row.name, 'tokenPrefix', token_row.token_prefix, 'expiresAt', token_row.expires_at, 'lastUsedAt', token_row.last_used_at, 'revokedAt', token_row.revoked_at, 'createdAt', token_row.created_at, 'grants', grants);
end;
$$;

drop function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb);
create function public.qnotes_replace_vault_agent_grants(
  p_owner_id uuid,
  p_token_id uuid,
  p_grants jsonb,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  token_row notesdb.vault_agent_tokens%rowtype;
  grant_item jsonb;
  grant_row notesdb.vault_agent_grants%rowtype;
  grants jsonb := '[]'::jsonb;
begin
  select * into token_row from notesdb.vault_agent_tokens where id = p_token_id and owner_id = p_owner_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  delete from notesdb.vault_agent_grants where token_id = p_token_id and owner_id = p_owner_id;
  for grant_item in select value from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb)) loop
    if (grant_item->>'secretId' is not null and grant_item->>'secretId' <> '') and (grant_item->>'environmentId' is null or grant_item->>'environmentId' = '') then raise exception 'Vault secret grant requires an environment'; end if;
    insert into notesdb.vault_agent_grants (owner_id, token_id, project_id, environment_id, secret_id, action)
    values (p_owner_id, p_token_id, (grant_item->>'projectId')::uuid, nullif(grant_item->>'environmentId', '')::uuid, nullif(grant_item->>'secretId', '')::uuid, grant_item->>'action')
    returning * into grant_row;
    grants := grants || jsonb_build_array(jsonb_build_object('id', grant_row.id, 'projectId', grant_row.project_id, 'environmentId', grant_row.environment_id, 'secretId', grant_row.secret_id, 'action', grant_row.action, 'createdAt', grant_row.created_at));
  end loop;
  perform public.qnotes_vault_append_audit_event(p_owner_id, 'user_jwt', null, 'grant:replace', null, null, null, 'Vault agent grants replaced', true, 'replaced', p_request_id, p_request_id, p_token_id);
  return jsonb_build_object('status', 'ok', 'grants', grants);
end;
$$;

drop function public.qnotes_revoke_vault_agent_token(uuid, uuid);
create function public.qnotes_revoke_vault_agent_token(
  p_owner_id uuid,
  p_token_id uuid,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare token_row notesdb.vault_agent_tokens%rowtype;
begin
  select * into token_row
  from notesdb.vault_agent_tokens
  where id = p_token_id and owner_id = p_owner_id
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if token_row.revoked_at is null then
    update notesdb.vault_agent_tokens
    set revoked_at = timezone('utc', now())
    where id = p_token_id and owner_id = p_owner_id;
  end if;
  perform public.qnotes_vault_append_audit_event(p_owner_id, 'user_jwt', null, 'token:revoke', null, null, null, 'Vault agent token revoked', true, 'revoked', p_request_id, p_request_id, p_token_id);
  return jsonb_build_object('status', 'ok');
end;
$$;

drop function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text);
create function public.qnotes_issue_vault_operation_approval(
  p_owner_id uuid,
  p_session_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hash text,
  p_approval_hash text,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
declare
  expires_at timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if p_session_id is null
    or p_action is null
    or p_action not in ('secret:reveal', 'secret:write', 'secret:delete', 'token:issue', 'token:revoke', 'grant:replace')
    or (p_expected_version is not null and p_expected_version < 1)
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_approval_hash is null or p_approval_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid Vault operation approval';
  end if;
  insert into notesdb.vault_operation_approvals (owner_id, session_id, action, project_id, environment_id, secret_id, expected_version, request_hash, approval_hash, expires_at)
  values (p_owner_id, p_session_id, p_action, p_project_id, p_environment_id, p_secret_id, p_expected_version, p_request_hash, p_approval_hash, expires_at);
  perform public.qnotes_vault_append_audit_event(p_owner_id, 'user_jwt', null, 'auth:step_up', p_project_id, p_environment_id, p_secret_id, 'Vault step-up verified', true, 'verified', p_request_id, p_request_id, null);
  perform public.qnotes_vault_append_audit_event(p_owner_id, 'user_jwt', null, 'approval:issue', p_project_id, p_environment_id, p_secret_id, 'Vault operation approval issued', true, 'issued', p_request_id, p_request_id, null);
  return jsonb_build_object('status', 'ok', 'expiresAt', expires_at);
end;
$$;

drop function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text);
create function public.qnotes_consume_vault_operation_approval(
  p_owner_id uuid,
  p_session_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hash text,
  p_approval_hash text,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  approval_row notesdb.vault_operation_approvals%rowtype;
begin
  select * into approval_row
  from notesdb.vault_operation_approvals
  where owner_id = p_owner_id and approval_hash = p_approval_hash
  for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if approval_row.used_at is not null then return jsonb_build_object('status', 'used'); end if;
  if approval_row.expires_at <= clock_timestamp() then return jsonb_build_object('status', 'expired'); end if;
  if approval_row.session_id is distinct from p_session_id
    or approval_row.action is distinct from p_action
    or approval_row.project_id is distinct from p_project_id
    or approval_row.environment_id is distinct from p_environment_id
    or approval_row.secret_id is distinct from p_secret_id
    or approval_row.expected_version is distinct from p_expected_version
    or approval_row.request_hash is distinct from p_request_hash then
    return jsonb_build_object('status', 'invalid');
  end if;
  update notesdb.vault_operation_approvals
  set used_at = clock_timestamp()
  where id = approval_row.id;
  perform public.qnotes_vault_append_audit_event(p_owner_id, 'user_jwt', null, 'approval:consume', p_project_id, p_environment_id, p_secret_id, 'Vault operation approval consumed', true, 'consumed', p_request_id, p_request_id, null);
  return jsonb_build_object('status', 'ok');
end;
$$;

create function public.qnotes_create_vault_agent_token(
  p_owner_id uuid,
  p_name text,
  p_token_prefix text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_grants jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  return public.qnotes_create_vault_agent_token(p_owner_id, p_name, p_token_prefix, p_token_hash, p_expires_at, p_grants, null);
end;
$$;

create function public.qnotes_replace_vault_agent_grants(
  p_owner_id uuid,
  p_token_id uuid,
  p_grants jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
begin
  return public.qnotes_replace_vault_agent_grants(p_owner_id, p_token_id, p_grants, null);
end;
$$;

create function public.qnotes_revoke_vault_agent_token(
  p_owner_id uuid,
  p_token_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
begin
  return public.qnotes_revoke_vault_agent_token(p_owner_id, p_token_id, null);
end;
$$;

create function public.qnotes_issue_vault_operation_approval(
  p_owner_id uuid,
  p_session_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hash text,
  p_approval_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  return public.qnotes_issue_vault_operation_approval(
    p_owner_id, p_session_id, p_action, p_project_id, p_environment_id,
    p_secret_id, p_expected_version, p_request_hash, p_approval_hash, null
  );
end;
$$;

create function public.qnotes_consume_vault_operation_approval(
  p_owner_id uuid,
  p_session_id uuid,
  p_action text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hash text,
  p_approval_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
begin
  return public.qnotes_consume_vault_operation_approval(
    p_owner_id, p_session_id, p_action, p_project_id, p_environment_id,
    p_secret_id, p_expected_version, p_request_hash, p_approval_hash, null
  );
end;
$$;

alter function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) owner to qnotes_vault_audit_maintenance;

revoke all on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_revoke_vault_agent_token(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.qnotes_revoke_vault_agent_token(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb, uuid) to service_role;
grant execute on function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb, uuid) to service_role;
grant execute on function public.qnotes_revoke_vault_agent_token(uuid, uuid, uuid) to service_role;
grant execute on function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text, uuid) to service_role;
grant execute on function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text, uuid) to service_role;
grant execute on function public.qnotes_vault_append_audit_event(uuid, text, uuid, text, uuid, uuid, uuid, text, boolean, text, uuid, uuid) to service_role;
grant execute on function public.qnotes_create_vault_agent_token(uuid, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.qnotes_replace_vault_agent_grants(uuid, uuid, jsonb) to service_role;
grant execute on function public.qnotes_revoke_vault_agent_token(uuid, uuid) to service_role;
grant execute on function public.qnotes_issue_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.qnotes_consume_vault_operation_approval(uuid, uuid, text, uuid, uuid, uuid, bigint, text, text) to service_role;

comment on column notesdb.vault_audit_events.target_token_id is 'Safe identifier of the token targeted by an administrative event; never a credential or token hash.';
comment on column notesdb.vault_audit_outbox.lease_token is 'Per-claim fencing token required to acknowledge or retry an export lease.';
