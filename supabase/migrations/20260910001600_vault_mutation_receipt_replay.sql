-- US-17: retain enough safe mutation identity to replay an authorized result
-- after the Vault resource has been deleted or its first response was lost.

alter table notesdb.vault_mutations
  add column if not exists project_id uuid,
  add column if not exists environment_id uuid,
  add column if not exists expected_version bigint,
  add column if not exists actor_kind text,
  add column if not exists actor_token_id uuid,
  add column if not exists retention_expires_at timestamptz,
  add column if not exists hash_key_version text not null default 'v1';

update notesdb.vault_mutations
set project_id = case
      when response #>> '{secret,projectId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (response #>> '{secret,projectId}')::uuid
      else project_id
    end,
    environment_id = case
      when response #>> '{secret,environmentId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (response #>> '{secret,environmentId}')::uuid
      else environment_id
    end,
    secret_id = case
      when response #>> '{secret,id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (response #>> '{secret,id}')::uuid
      else secret_id
    end,
    expected_version = case
      when operation in ('rotated', 'deleted') and resulting_version > 1 then resulting_version - 1
      else expected_version
    end
where project_id is null or environment_id is null or secret_id is null or expected_version is null;

with success_audits as (
  select distinct on (owner_id, operation_id)
    owner_id,
    operation_id,
    actor_kind,
    actor_token_id
  from notesdb.vault_audit_events
  where operation_id is not null
    and success
    and action in ('secret:write', 'secret:delete')
  order by owner_id, operation_id, occurred_at desc
)
update notesdb.vault_mutations mutation
set actor_kind = success_audits.actor_kind,
    actor_token_id = success_audits.actor_token_id
from success_audits
where mutation.owner_id = success_audits.owner_id
  and mutation.mutation_id = success_audits.operation_id
  and mutation.actor_kind is null;

update notesdb.vault_mutations
set retention_expires_at = created_at + interval '30 days'
where retention_expires_at is null;

alter table notesdb.vault_mutations
  alter column retention_expires_at set default (timezone('utc', now()) + interval '30 days'),
  alter column retention_expires_at set not null;

alter table notesdb.vault_mutations
  add constraint vault_mutations_operation_check
    check (operation in ('created', 'rotated', 'deleted')),
  add constraint vault_mutations_expected_version_check
    check (expected_version is null or expected_version > 0),
  add constraint vault_mutations_actor_kind_check
    check (actor_kind is null or actor_kind in ('user_jwt', 'vault_agent')),
  add constraint vault_mutations_actor_token_check
    check (actor_token_id is null or actor_kind = 'vault_agent'),
  add constraint vault_mutations_retention_check
    check (retention_expires_at > created_at),
  add constraint vault_mutations_hash_key_version_check
    check (hash_key_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$');

create index if not exists vault_mutations_owner_retention_key
  on notesdb.vault_mutations (owner_id, retention_expires_at);

create or replace function notesdb.vault_mutation_identity_defaults()
returns trigger
language plpgsql
security definer
set search_path = notesdb, public, extensions, pg_temp
as $$
declare
  project_text text;
  environment_text text;
  secret_text text;
  audit_actor_kind text;
  audit_actor_token_id uuid;
begin
  project_text := new.response #>> '{secret,projectId}';
  environment_text := new.response #>> '{secret,environmentId}';
  secret_text := new.response #>> '{secret,id}';
  if new.project_id is null and project_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.project_id := project_text::uuid;
  end if;
  if new.environment_id is null and environment_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.environment_id := environment_text::uuid;
  end if;
  if new.secret_id is null and secret_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.secret_id := secret_text::uuid;
  end if;
  if new.expected_version is null and new.operation in ('rotated', 'deleted') and new.resulting_version > 1 then
    new.expected_version := new.resulting_version - 1;
  end if;
  new.retention_expires_at := coalesce(new.retention_expires_at, new.created_at + interval '30 days');
  if new.actor_kind is null then
    select event.actor_kind, event.actor_token_id
    into audit_actor_kind, audit_actor_token_id
    from notesdb.vault_audit_events event
    where event.owner_id = new.owner_id
      and event.operation_id = new.mutation_id
      and event.success
      and event.action in ('secret:write', 'secret:delete')
    order by event.occurred_at desc
    limit 1;
    new.actor_kind := audit_actor_kind;
    new.actor_token_id := audit_actor_token_id;
  end if;
  return new;
end;
$$;

drop trigger if exists vault_mutations_identity_defaults on notesdb.vault_mutations;
create trigger vault_mutations_identity_defaults
before insert on notesdb.vault_mutations
for each row execute function notesdb.vault_mutation_identity_defaults();

create or replace function public.qnotes_vault_lock_mutation(
  p_owner_id uuid,
  p_mutation_id uuid
) returns void
language plpgsql
security definer
set search_path = public, notesdb, extensions
as $$
begin
  if p_owner_id is null or p_mutation_id is null then
    raise exception 'invalid Vault mutation identity';
  end if;
  -- ponytail: one owner/mutation advisory lock serializes first attempts; use
  -- finer-grained claims only if mutation throughput makes this measurable.
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_mutation_id::text, 0));
end;
$$;

create or replace function public.qnotes_vault_get_mutation_receipt(
  p_owner_id uuid,
  p_mutation_id uuid,
  p_operation text,
  p_project_id uuid,
  p_environment_id uuid,
  p_secret_id uuid,
  p_expected_version bigint,
  p_request_hashes text[],
  p_actor_token_id uuid,
  p_actor_kind text,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare
  stored notesdb.vault_mutations%rowtype;
  authz jsonb;
  action text;
  safe_secret jsonb;
  receipt jsonb;
begin
  select * into stored
  from notesdb.vault_mutations
  where owner_id = p_owner_id and mutation_id = p_mutation_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  action := case stored.operation
    when 'created' then 'secret:write'
    when 'rotated' then 'secret:write'
    when 'deleted' then 'secret:delete'
    else null
  end;
  if action is null or p_actor_kind not in ('user_jwt', 'vault_agent') then
    return jsonb_build_object('status', 'access_denied');
  end if;

  -- The receipt is authorized against its retained identity before request
  -- matching, so an unauthorized caller cannot turn a reused ID into an oracle.
  authz := public.qnotes_vault_authorize_actor(
    stored.owner_id,
    p_actor_token_id,
    p_actor_kind,
    action,
    stored.project_id,
    stored.environment_id,
    stored.secret_id,
    p_request_id
  );
  if authz->>'status' <> 'ok' then
    return jsonb_build_object('status', 'access_denied');
  end if;

  if jsonb_typeof(stored.response->'secret') = 'object' then
    safe_secret := jsonb_build_object(
      'id', stored.response->'secret'->>'id',
      'projectId', stored.response->'secret'->>'projectId',
      'environmentId', stored.response->'secret'->>'environmentId',
      'name', stored.response->'secret'->>'name',
      'description', stored.response->'secret'->'description',
      'version', stored.response->'secret'->'version',
      'createdAt', stored.response->'secret'->>'createdAt',
      'updatedAt', stored.response->'secret'->>'updatedAt',
      'rotatedAt', stored.response->'secret'->'rotatedAt',
      'deletedAt', stored.response->'secret'->'deletedAt'
    );
  else
    safe_secret := null;
  end if;

  receipt := jsonb_build_object(
    'mutationId', stored.mutation_id,
    'operation', stored.operation,
    'projectId', stored.project_id,
    'environmentId', stored.environment_id,
    'secretId', stored.secret_id,
    'expectedVersion', stored.expected_version,
    'resultingVersion', stored.resulting_version,
    'createdAt', stored.created_at,
    'retentionExpiresAt', stored.retention_expires_at,
    'hashKeyVersion', stored.hash_key_version,
    'status', 'complete',
    'result', safe_secret
  );

  if p_request_hashes is not null then
    if p_operation is null
      or stored.operation is distinct from p_operation
      or (p_project_id is not null and stored.project_id is distinct from p_project_id)
      or (p_environment_id is not null and stored.environment_id is distinct from p_environment_id)
      or (p_secret_id is not null and stored.secret_id is distinct from p_secret_id)
      or stored.expected_version is distinct from p_expected_version
      or not (stored.request_hash = any(p_request_hashes)) then
      return jsonb_build_object('status', 'mutation_reuse_conflict');
    end if;
    if stored.retention_expires_at <= clock_timestamp() then
      return receipt || jsonb_build_object('status', 'expired', 'result', null);
    end if;
    return jsonb_build_object('status', 'idempotent', 'secret', safe_secret, 'receipt', receipt);
  end if;

  if stored.retention_expires_at <= clock_timestamp() then
    return receipt || jsonb_build_object('status', 'expired', 'result', null);
  end if;
  return receipt;
end;
$$;

-- Keep the US-04 authorization wrappers, adding a transaction lock before the
-- actor/resource lock. The legacy functions then re-check the receipt after a
-- competing first attempt commits.
create or replace function public.qnotes_vault_create_secret(
  p_owner_id uuid, p_project_id uuid, p_environment_id uuid, p_name text,
  p_description text, p_value text, p_mutation_id uuid, p_request_hash text,
  p_actor_token_id uuid, p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  perform public.qnotes_vault_lock_mutation(p_owner_id, p_mutation_id);
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:write', p_project_id, p_environment_id, null, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_create_secret_legacy(p_owner_id, p_project_id, p_environment_id, p_name, p_description, p_value, p_mutation_id, p_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_rotate_secret(
  p_owner_id uuid, p_secret_id uuid, p_value text, p_description text,
  p_expected_version bigint, p_mutation_id uuid, p_request_hash text,
  p_actor_token_id uuid, p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  perform public.qnotes_vault_lock_mutation(p_owner_id, p_mutation_id);
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:write', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_rotate_secret_legacy(p_owner_id, p_secret_id, p_value, p_description, p_expected_version, p_mutation_id, p_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_rotate_secret(
  p_owner_id uuid, p_secret_id uuid, p_value text, p_description text,
  p_expected_version bigint, p_mutation_id uuid, p_request_hash text,
  p_legacy_request_hash text, p_actor_token_id uuid, p_request_id uuid,
  p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  perform public.qnotes_vault_lock_mutation(p_owner_id, p_mutation_id);
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:write', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_rotate_secret_replay_legacy(p_owner_id, p_secret_id, p_value, p_description, p_expected_version, p_mutation_id, p_request_hash, p_legacy_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

create or replace function public.qnotes_vault_delete_secret(
  p_owner_id uuid, p_secret_id uuid, p_expected_version bigint,
  p_mutation_id uuid, p_request_hash text, p_actor_token_id uuid,
  p_request_id uuid, p_actor_kind text
) returns jsonb
language plpgsql
security definer
set search_path = public, notesdb, extensions
set lock_timeout = '5s'
as $$
declare authz jsonb;
begin
  perform public.qnotes_vault_lock_mutation(p_owner_id, p_mutation_id);
  authz := public.qnotes_vault_authorize_actor(p_owner_id, p_actor_token_id, p_actor_kind, 'secret:delete', null, null, p_secret_id, p_request_id);
  if authz->>'status' <> 'ok' then return authz; end if;
  return public.qnotes_vault_delete_secret_legacy(p_owner_id, p_secret_id, p_expected_version, p_mutation_id, p_request_hash, p_actor_token_id, p_request_id, p_actor_kind);
end;
$$;

revoke all on function public.qnotes_vault_lock_mutation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qnotes_vault_get_mutation_receipt(uuid, uuid, text, uuid, uuid, uuid, bigint, text[], uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.qnotes_vault_lock_mutation(uuid, uuid) to service_role;
grant execute on function public.qnotes_vault_get_mutation_receipt(uuid, uuid, text, uuid, uuid, uuid, bigint, text[], uuid, text, uuid) to service_role;

comment on column notesdb.vault_mutations.retention_expires_at is 'Safe mutation receipt retention ends 30 days after creation; expired rows report status without returning the result.';
comment on column notesdb.vault_mutations.hash_key_version is 'Version of the domain-separated mutation hash construction; retain compatible pepper keys through the receipt horizon before retirement.';
